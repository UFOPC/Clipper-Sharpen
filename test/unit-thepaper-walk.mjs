/* 澎湃（thepaper）正文序列化的等价性检查。
 *
 * 为什么单独写一个：thepaper 没有真实页面快照，`dump-md --check` 覆盖不到它，
 * 但它的 walkBody 是 M-5 里改动最大的一个（6 份拷贝之一，且唯一处理 HLS、
 * iframe、音视频缺址、媒体上限这四类「留痕」）。只靠 node --check 过语法是不够的，
 * 那证明不了输出没变。
 *
 * 做法：把「旧实现」按原样抄进本文件的 LEGACY()，与新实现（走 dom-to-md.js 的
 * walkWith）跑同一批合成 DOM，逐字符比对 text 与 media 两路输出。
 *
 * 这批 DOM 有意覆盖的边界：
 *   - 标题 h1（旧实现按 # 全档输出）
 *   - 有序/无序列表（ol 要带序号）
 *   - strong/em/code 行内标记
 *   - 站外链接与无 href 的 <a>（不能写出半截 markdown）
 *   - <a> 里包 <img>（不能既写链接又写占位符）
 *   - blockquote 与 figcaption（只有 blockquote 写引用行）
 *   - img 走 imageUrl（含 x-oss-process 原图改写、与不含该参数两种）
 *   - audio/video 有 src、无 src、以及 .m3u8（后两类必须留痕而不是静默丢）
 *   - iframe（留痕）
 *   - 超过 MAX_MEDIA 的图片洪水（truncated 置真且不多记）
 *   - voiceInfo.voiceSrc 的「听全文」尾段
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = process.env.EXT_DIR || path.resolve(".");
const MAX_MEDIA = 300;

/* ---------- 被测件：真实的 content/dom-to-md.js 与 thepaper.js 的 walkBody ---------- */

const domSource = fs.readFileSync(path.join(EXT, "content", "dom-to-md.js"), "utf8");
const paperSource = fs.readFileSync(path.join(EXT, "content", "thepaper.js"), "utf8");

/* thepaper.js 是个 IIFE，里面把 walkBody / imageUrl / mediaElementUrl / normalizeMediaUrl
 * 都关在私有作用域里。为了不改产品代码就能测到它，这里用正则把这些函数的源码抠出来
 * 单独求值——它们本身不依赖闭包里别的东西（BLOCK/DROP/MAX_MEDIA 一起抠）。 */
function extract(name, source) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 function ${name}()，测试需要跟着源码改`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const pieces = [
  "const MAX_MEDIA = 300;",
  extract("imageUrl", paperSource),
  extract("mediaElementUrl", paperSource),
  extract("normalizeMediaUrl", paperSource),
  extract("walkBody", paperSource),
].join("\n");

/* ---------- DOM 小工具 ---------- */
/* 用 jsdom 是额外依赖，这里的手写桩只覆盖 walkBody 真正会碰到的 API：
 * nodeType / tagName / nodeValue / childNodes / classList / getAttribute /
 * querySelector / textContent / parentElement / children。 */

class FakeNode {
  constructor(type, tag, attrs = {}) {
    this.nodeType = type;
    this.tagName = (tag || "").toUpperCase();
    this._attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
    this.classList = {
      contains: (name) => (this._attrs.class || "").split(/\s+/).includes(name),
    };
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
    return this;
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((node) => node.textContent).join("");
  }
  /* 只需要支持「有没有 img 后代」与「有没有 video 后代」这两种用法 */
  querySelector(sel) {
    const want = sel.toLowerCase();
    let found = null;
    const scan = (node) => {
      if (found) return;
      if (node.nodeType === 1 && node.tagName.toLowerCase() === want) {
        found = node;
        return;
      }
      for (const child of node.childNodes || []) scan(child);
    };
    for (const child of this.childNodes) scan(child);
    return found;
  }
}

const el = (tag, attrs, ...children) => {
  const node = new FakeNode(1, tag, attrs);
  node.append(...children.map((c) => (typeof c === "string" ? new FakeNode(3, "", {}) : c)));
  /* 字符串子节点要带走文本，FakeNode(3) 用 nodeValue 存 */
  let i = 0;
  for (const c of children) {
    if (typeof c === "string") node.childNodes[i].nodeValue = c;
    i++;
  }
  return node;
};

/* ---------- 旧实现（原名照抄，只把闭包外的依赖改为同文件内的等价物） ---------- */
function LEGACY(root, data, BLOCK, DROP, squash, location) {
  const out = [];
  const media = [];
  const seen = new Set();
  let unsupported = 0;
  let truncated = false;

  const push = (text) => {
    if (text) out.push(text);
  };

  function addMedia(url, kind) {
    if (!url || seen.has(url)) return;
    if (kind !== "image" && /\.m3u8(?:$|[?#])/i.test(url)) {
      unsupported++;
      push("\n\n> HLS（m3u8）媒体暂不支持直接下载。\n\n");
      return;
    }
    if (media.length >= MAX_MEDIA) {
      truncated = true;
      return;
    }
    seen.add(url);
    media.push({ url, kind });
    push("\n\n\u0000" + (media.length - 1) + "\u0000\n\n");
  }

  function walk(node) {
    if (node.nodeType === 3) {
      push(node.nodeValue.replace(/\u00a0/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (DROP.has(tag)) return;

    if (tag === "img") {
      addMedia(imageUrl(node), "image");
      return;
    }
    if (tag === "video" || tag === "audio") {
      const url = mediaElementUrl(node);
      if (url) addMedia(url, tag);
      else {
        unsupported++;
        push(`\n\n> ${tag === "video" ? "视频" : "音频"}未取到可下载地址。\n\n`);
      }
      return;
    }
    if (tag === "iframe") {
      unsupported++;
      push("\n\n> iframe 内嵌内容未下载。\n\n");
      return;
    }
    if (tag === "br") { push("\n"); return; }
    if (tag === "hr") { push("\n\n---\n\n"); return; }
    if (/^h[1-6]$/.test(tag)) {
      push("\n\n" + "#".repeat(Number(tag[1])) + " ");
      for (const child of node.childNodes) walk(child);
      push("\n\n");
      return;
    }
    if (tag === "strong" || tag === "b") {
      push("**");
      for (const child of node.childNodes) walk(child);
      push("**");
      return;
    }
    if (tag === "em" || tag === "i") {
      push("*");
      for (const child of node.childNodes) walk(child);
      push("*");
      return;
    }
    if (tag === "code") {
      push("`");
      for (const child of node.childNodes) walk(child);
      push("`");
      return;
    }
    if (tag === "a" && !node.querySelector("img")) {
      const text = squash(node.textContent);
      const raw = node.getAttribute("href") || "";
      try {
        const href = new URL(raw, location.href);
        if (text && /^https?:$/.test(href.protocol)) {
          push(`[${text}](${href.href})`);
          return;
        }
      } catch (error) {
        /* 无有效地址时保留链接文字，继续走普通节点。 */
      }
    }
    if (tag === "li") {
      const parent = node.parentElement;
      const ordered = parent && parent.tagName.toLowerCase() === "ol";
      const index = ordered ? [...parent.children].indexOf(node) + 1 : 0;
      push("\n" + (ordered ? `${index}. ` : "- "));
      for (const child of node.childNodes) walk(child);
      push("\n");
      return;
    }
    if (tag === "blockquote") {
      push("\n\n> ");
      for (const child of node.childNodes) walk(child);
      push("\n\n");
      return;
    }

    if (BLOCK.has(tag)) push("\n\n");
    for (const child of node.childNodes) walk(child);
    if (BLOCK.has(tag)) push("\n\n");
  }

  walk(root);

  const voice = normalizeMediaUrl(data && data.voiceInfo && data.voiceInfo.voiceSrc);
  if (voice && !seen.has(voice)) {
    push("\n\n## 听全文\n\n");
    addMedia(voice, "audio");
  }

  const text = out
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, media, unsupported, truncated };
}

/* 旧实现用到的 imageUrl / mediaElementUrl / normalizeMediaUrl 与生产代码一致，直接从
 * thepaper.js 抠出来复用——这样比对的是「新老 walk」而非「新老 imageUrl」。 */
const paperScope = vm.createContext({ MAX_MEDIA, URL, console, location: { href: "https://www.thepaper.cn/newsDetail_forward_1" } });
vm.runInContext(
  [
    "const MAX_MEDIA = 300;",
    extract("imageUrl", paperSource),
    extract("mediaElementUrl", paperSource),
    extract("normalizeMediaUrl", paperSource),
    "globalThis.__fn = { imageUrl, mediaElementUrl, normalizeMediaUrl };",
  ].join("\n"),
  paperScope
);
const { imageUrl, mediaElementUrl, normalizeMediaUrl } = paperScope.__fn;

/* 新实现：加载真实的 dom-to-md.js，再把 thepaper 的 walkBody 放进同一个上下文跑。 */
const ctx = vm.createContext({
  URL,
  console,
  location: { href: "https://www.thepaper.cn/newsDetail_forward_1" },
  globalThis: null,
});
ctx.globalThis = ctx;
/* 生产代码在浏览器里是 globalThis；vm 里要用同一个对象，两个脚本才互相看得见 */
vm.runInContext("globalThis.__XHX_DOM = undefined;", ctx);
vm.runInContext(domSource, ctx);
vm.runInContext(
  [
    "const MAX_MEDIA = 300;",
    /* BLOCK/DROP 现在直接取 dom-to-md.js 的；LOCAL_DROP 也从源码抠，保证测的是生产逻辑 */
    "const squash = (v) => String(v || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();",
    extract("imageUrl", paperSource),
    extract("mediaElementUrl", paperSource),
    extract("normalizeMediaUrl", paperSource),
    extract("localDrop", paperSource),
    extract("walkBody", paperSource),
    "globalThis.__walkBody = walkBody;",
  ].join("\n"),
  ctx
);
const newWalk = ctx.__walkBody;

/* ---------- 用例 ---------- */
const mk = () => el("div");

const cases = [
  {
    name: "标题/段落/粗细斜体/代码",
    root: () => el("div", {},
      el("h1", {}, "大标题"),
      el("h2", {}, "二级"),
      el("p", {}, "普通", el("strong", {}, "加粗"), "文字", el("em", {}, "斜体")),
      el("p", {}, el("code", {}, "x=1"))),
  },
  {
    name: "有序与无序列表",
    root: () => el("div", {},
      el("ol", {}, el("li", {}, "第一"), el("li", {}, "第二")),
      el("ul", {}, el("li", {}, "甲"), el("li", {}, "乙"))),
  },
  {
    name: "站外链接、无 href、a 里包 img",
    root: () => el("div", {},
      el("a", { href: "https://example.com/x" }, "站外"),
      el("a", {}, "空链接"),
      el("a", { href: "https://example.com/y" }, el("img", { src: "https://img.example.com/a.jpg" }))),
  },
  {
    name: "blockquote 与 figcaption",
    root: () => el("div", {},
      el("blockquote", {}, "引用"),
      el("figcaption", {}, "图注")),
  },
  {
    name: "图片：带 x-oss-process 与不带",
    root: () => el("div", {},
      el("img", { src: "https://image.thepaper.cn/a.jpg?x-oss-process=image/resize,w_600" }),
      el("img", { src: "https://image.thepaper.cn/b.jpg" }),
      el("img", { src: "https://image.thepaper.cn/b.jpg" })),
  },
  {
    name: "音视频：有 src / 无 src / m3u8",
    root: () => el("div", {},
      el("audio", { src: "https://audio.thepaper.cn/a.mp3" }),
      el("video", { src: "https://video.thepaper.cn/v.mp4" }),
      el("video", {}),
      el("audio", { src: "https://live.thepaper.cn/x.m3u8" })),
  },
  {
    name: "iframe 留痕",
    root: () => el("div", {}, el("iframe", { src: "https://x.example.com" })),
  },
  {
    name: "br 与 hr",
    root: () => el("div", {}, el("p", {}, "上", el("br", {}), "下"), el("hr", {})),
  },
  {
    name: "听全文尾段",
    root: () => el("div", {}, el("p", {}, "正文")),
    data: { voiceInfo: { voiceSrc: "https://audio.thepaper.cn/voice.mp3" } },
  },
  {
    name: "听全文与正文音频同址（历史行为：仍补一节）",
    /* 旧实现先写「## 听全文」再 addMedia，addMedia 因 seen 命中而什么也不做，
     * 于是 md 里留了一个没有下文的空小节。这是既存瑕疵，M-5 只做收敛不改行为，
     * 故这里锁住旧样；要修它属于单独一条 issue。 */
    root: () => el("div", {}, el("audio", { src: "https://audio.thepaper.cn/voice.mp3" })),
    data: { voiceInfo: { voiceSrc: "https://audio.thepaper.cn/voice.mp3" } },
  },
  {
    name: "超过 MAX_MEDIA 的图片洪水",
    root: () => {
      const root = el("div", {});
      for (let i = 0; i <= MAX_MEDIA + 5; i++) {
        root.append(el("img", { src: `https://image.thepaper.cn/flood-${i}.jpg` }));
      }
      return root;
    },
  },
];

/* ---------- 跑 ---------- */
let bad = 0;
for (const item of cases) {
  const legacy = LEGACY(item.root(), item.data || {}, new Set([
    "address", "article", "aside", "blockquote", "div", "dl", "dt", "dd",
    "figure", "figcaption", "footer", "header", "ol", "p", "pre", "section",
    "table", "tbody", "thead", "tfoot", "tr", "ul",
  ]), new Set(["script", "style", "noscript", "svg", "input", "button", "source", "track"]),
  (v) => String(v || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(),
  { href: "https://www.thepaper.cn/newsDetail_forward_1" });

  const fresh = newWalk(item.root(), item.data || {});

  const problems = [];
  if (legacy.text !== fresh.text) {
    let i = 0;
    while (i < legacy.text.length && i < fresh.text.length && legacy.text[i] === fresh.text[i]) i++;
    problems.push(`text 第 ${i} 字符起不同\n      旧「${JSON.stringify(legacy.text.slice(i, i + 70))}」\n      新「${JSON.stringify(fresh.text.slice(i, i + 70))}」`);
  }
  const lj = JSON.stringify(legacy.media);
  const fj = JSON.stringify(fresh.media);
  if (lj !== fj) problems.push(`media 不同\n      旧 ${lj.slice(0, 200)}\n      新 ${fj.slice(0, 200)}`);
  if (legacy.unsupported !== fresh.unsupported) problems.push(`unsupported 不同：旧 ${legacy.unsupported} 新 ${fresh.unsupported}`);
  if (legacy.truncated !== fresh.truncated) problems.push(`truncated 不同：旧 ${legacy.truncated} 新 ${fresh.truncated}`);

  if (problems.length) {
    bad++;
    console.log(`  FAIL  ${item.name}`);
    for (const line of problems) console.log(`      ${line}`);
  } else {
    console.log(`  PASS  ${item.name}`);
  }
}

console.log(bad ? `\n✗ ${bad} 组行为变了` : "\n✓ 澎湃正文序列化与旧实现逐字符一致");
process.exit(bad ? 1 : 0);
