/* 公众号（wechat）正文序列化的等价性检查——和 unit-thepaper-walk.mjs 同一套做法。
 *
 * 公众号的 toMarkdown 是 6 份拷贝里唯一不用占位符的：它走 onImage 回调直接产出 md
 * 片段。M-5 把它收敛到 dom-to-md.js 时，最容易被改坏的三处是
 *   ① 图片两侧的空行（占位符是普通字符，换行会原样进 md）
 *   ② 重复出现的同一张图要不要再写一次引用（要——去重只该省下载，不该省引用）
 *   ③ 行首空格必须保留（正文靠它做缩进），这一条与其余五站都相反
 * 所以这里逐条造 DOM 锁住它们，并把旧实现原样抄进 LEGACY() 做逐字符比对。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = process.env.EXT_DIR || path.resolve(".");
const domSource = fs.readFileSync(path.join(EXT, "content", "dom-to-md.js"), "utf8");
const wechatSource = fs.readFileSync(path.join(EXT, "content", "wechat.js"), "utf8");

function extract(name, source) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 function ${name}()，测试需要跟着源码改`);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

/* ---------- DOM 桩（只覆盖 walk 会碰到的属性） ---------- */
class FakeNode {
  constructor(type, tag, attrs = {}) {
    this.nodeType = type;
    this.tagName = (tag || "").toUpperCase();
    this._attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
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
  querySelector() {
    return null;
  }
}

const el = (tag, attrs, ...children) => {
  const node = new FakeNode(1, tag, attrs);
  for (const c of children) {
    const child = typeof c === "string" ? new FakeNode(3, "", {}) : c;
    if (typeof c === "string") child.nodeValue = c;
    node.append(child);
  }
  return node;
};

/* 所有用例共用同一套 onImage：每张图产出 ![no](images/x-NN.ext)，
 * 并按真实逻辑去重（同 URL 重复出现时复用同一个 no/path）。 */
function makeOnImage() {
  const byUrl = new Map();
  const media = [];
  let truncated = false;
  const MAX_IMAGES = 300;
  const onImage = (src, index) => {
    if (byUrl.has(src)) {
      const no = media.find((m) => m.url === src).no;
      return `![${no}](./${byUrl.get(src)})`;
    }
    if (media.length >= MAX_IMAGES) {
      truncated = true;
      return "";
    }
    const no = media.length + 1;
    const relPath = `images/x-${String(no).padStart(2, "0")}-${index}.png`;
    media.push({ url: src, no, path: relPath });
    byUrl.set(src, relPath);
    return `![${no}](./${relPath})`;
  };
  return { onImage, media, isTruncated: () => truncated };
}

const imageUrl = (node) => {
  const raw = node.getAttribute("data-src") || node.getAttribute("src") || "";
  return /^https?:\/\//i.test(raw) ? raw : "";
};

/* ---------- 旧实现（照抄 content/wechat.js 的 toMarkdown） ---------- */
function LEGACY(root, onImage, BLOCK, DROP, squash) {
  const out = [];
  let imgIndex = 0;

  const walk = (node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue.replace(/\u00a0/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (DROP.test(tag)) return;

    if (tag === "img") {
      const url = imageUrl(node);
      if (url && onImage) {
        const md = onImage(url, imgIndex++);
        if (md) out.push("\n\n", md, "\n\n");
      }
      return;
    }
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      out.push("\n\n", "#".repeat(level), " ");
      for (const child of node.childNodes) walk(child);
      out.push("\n\n");
      return;
    }
    if (tag === "strong" || tag === "b") {
      out.push("**");
      for (const child of node.childNodes) walk(child);
      out.push("**");
      return;
    }
    if (tag === "em" || tag === "i") {
      out.push("*");
      for (const child of node.childNodes) walk(child);
      out.push("*");
      return;
    }
    if (tag === "code") {
      out.push("`");
      for (const child of node.childNodes) walk(child);
      out.push("`");
      return;
    }
    if (tag === "a") {
      const text = squash(node.textContent);
      const href = node.getAttribute("href") || "";
      if (!text) return;
      if (/^https?:\/\//i.test(href) && !/^https?:\/\/mp\.weixin\.qq\.com\//i.test(href)) {
        out.push(`[${text}](${href})`);
      } else {
        out.push(text);
      }
      return;
    }
    if (tag === "li") {
      const parent = node.parentElement ? node.parentElement.tagName.toLowerCase() : "";
      const ordered = parent === "ol";
      const index = ordered ? [...node.parentElement.children].indexOf(node) + 1 : 0;
      out.push("\n", ordered ? `${index}. ` : "- ");
      for (const child of node.childNodes) walk(child);
      return;
    }
    if (tag === "blockquote") {
      out.push("\n\n> ");
      for (const child of node.childNodes) walk(child);
      out.push("\n\n");
      return;
    }
    if (BLOCK.has(tag)) out.push("\n\n");
    for (const child of node.childNodes) walk(child);
    if (BLOCK.has(tag)) out.push("\n\n");
  };

  walk(root);
  return out.join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- 新实现 ---------- */
const ctx = vm.createContext({
  URL,
  console,
  location: { href: "https://mp.weixin.qq.com/s/abc", hostname: "mp.weixin.qq.com" },
});
ctx.globalThis = ctx;
vm.runInContext(domSource, ctx);
vm.runInContext(
  [
    'const BLOCK = new Set(["section", "p", "div", "blockquote", "ul", "ol", "li", "tr", "table", "figure", "figcaption", "pre"]);',
    'const DROP = /^(script|style|svg|mp-style-type|iframe|video|audio|source)$/;',
    "const squash = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();",
    extract("imageUrl", wechatSource).replace(/extOf|searchParams/g, "0"),
    extract("toMarkdown", wechatSource),
    "globalThis.__toMarkdown = toMarkdown;",
  ].join("\n"),
  ctx
);
const newToMarkdown = ctx.__toMarkdown;

/* wechat.js 的 imageUrl 依赖 extOf 等，抠出来可能带别的作用域引用；
 * 这里用测试自己的 imageUrl 覆盖，保证「新老实现比的是 walk，不是取图规则」。 */
const newCtxSource = [
  'const BLOCK = new Set(["section", "p", "div", "blockquote", "ul", "ol", "li", "tr", "table", "figure", "figcaption", "pre"]);',
  'const DROP = /^(script|style|svg|mp-style-type|iframe|video|audio|source)$/;',
  "const squash = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();",
  "const imageUrl = (node) => { const raw = node.getAttribute('data-src') || node.getAttribute('src') || ''; return /^https?:\\/\\//i.test(raw) ? raw : ''; };",
  extract("toMarkdown", wechatSource),
  "globalThis.__toMarkdown = toMarkdown;",
].join("\n");
const ctx2 = vm.createContext({
  URL,
  console,
  location: { href: "https://mp.weixin.qq.com/s/abc", hostname: "mp.weixin.qq.com" },
});
ctx2.globalThis = ctx2;
vm.runInContext(domSource, ctx2);
vm.runInContext(newCtxSource, ctx2);
const newWalk = ctx2.__toMarkdown;

const BLOCK = new Set(["section", "p", "div", "blockquote", "ul", "ol", "li", "tr", "table", "figure", "figcaption", "pre"]);
const DROP = /^(script|style|svg|mp-style-type|iframe|video|audio|source)$/;
const squash = (s) => String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const cases = [
  {
    name: "嵌套 section 与段落（公众号典型结构）",
    root: () => el("div", {},
      el("section", {}, el("p", {}, "第一段")),
      el("section", {}, el("p", {}, "第二段"))),
  },
  {
    name: "行首空格必须保留（其余五站会压掉）",
    root: () => el("div", {}, el("p", {}, "　　这是两个全角空格的缩进"), el("p", {}, "  两个半角空格")),
  },
  {
    name: "标题/加粗/斜体/代码",
    root: () => el("div", {},
      el("h2", {}, "小标题"),
      el("p", {}, el("strong", {}, "粗"), el("em", {}, "斜"), el("code", {}, "c"))),
  },
  {
    name: "有序与无序列表",
    root: () => el("div", {},
      el("ol", {}, el("li", {}, "一"), el("li", {}, "二")),
      el("ul", {}, el("li", {}, "甲"), el("li", {}, "乙"))),
  },
  {
    name: "站内链接只留文字、站外写成链接、空文字整条丢",
    root: () => el("div", {},
      el("a", { href: "https://mp.weixin.qq.com/s/other" }, "站内"),
      el("a", { href: "https://example.com/x" }, "站外"),
      el("a", { href: "https://example.com/y" }, "")),
  },
  {
    name: "图片两侧空行（占位符换行会原样进 md）",
    root: () => el("div", {}, el("p", {}, "前"), el("img", { "data-src": "https://mmbiz.qpic.cn/a.png" }), el("p", {}, "后")),
  },
  {
    name: "同一张图出现两次：引用要留两次，编号复用",
    root: () => el("div", {},
      el("img", { "data-src": "https://mmbiz.qpic.cn/dup.png" }),
      el("p", {}, "中间"),
      el("img", { "data-src": "https://mmbiz.qpic.cn/dup.png" })),
  },
  {
    name: "wx_fmt 与 mmbiz 段都不可用时的图片",
    root: () => el("div", {}, el("img", { "data-src": "https://mmbiz.qpic.cn/whatever" })),
  },
  {
    name: "blockquote 与 br",
    root: () => el("div", {}, el("blockquote", {}, "引用"), el("p", {}, "上", el("br", {}), "下")),
  },
  {
    name: "DROP：script/style/iframe/video/audio/source 全不进正文",
    root: () => el("div", {},
      el("p", {}, "正文"),
      el("script", {}, "alert(1)"),
      el("style", {}, "p{}"),
      el("iframe", { src: "https://x" }),
      el("video", { src: "https://y.mp4" }),
      el("audio", { src: "https://z.mp3" })),
  },
  {
    name: "空内容",
    root: () => el("div", {}, el("p", {}, "   "), el("p", {}, "\u00a0")),
  },
];

let bad = 0;
for (const item of cases) {
  const legacyMk = makeOnImage();
  const legacy = LEGACY(item.root(), legacyMk.onImage, BLOCK, DROP, squash);
  const freshMk = makeOnImage();
  const fresh = newWalk(item.root(), freshMk.onImage);

  const problems = [];
  if (legacy !== fresh) {
    let i = 0;
    while (i < legacy.length && i < fresh.length && legacy[i] === fresh[i]) i++;
    problems.push(`第 ${i} 字符起不同\n      旧「${JSON.stringify(legacy.slice(i, i + 80))}」\n      新「${JSON.stringify(fresh.slice(i, i + 80))}」`);
  }
  const lj = JSON.stringify(legacyMk.media);
  const fj = JSON.stringify(freshMk.media);
  if (lj !== fj) problems.push(`media 不同\n      旧 ${lj.slice(0, 200)}\n      新 ${fj.slice(0, 200)}`);

  if (problems.length) {
    bad++;
    console.log(`  FAIL  ${item.name}`);
    for (const line of problems) console.log(`      ${line}`);
  } else {
    console.log(`  PASS  ${item.name}`);
  }
}

console.log(bad ? `\n✗ ${bad} 组行为变了` : "\n✓ 公众号正文序列化与旧实现逐字符一致");
process.exit(bad ? 1 : 0);
