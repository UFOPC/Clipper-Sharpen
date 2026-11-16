/* 澎湃的媒体引用语法：图片、视频、音频必须写同一套 Markdown。
 *
 * 这里守的是一个具体事故的形状：音频曾经单独用 Obsidian 的 `![[path]]`
 * wikilink，wikilink 只按 vault 根解析，笔记落在 <日期>_<标题>/ 子目录里时
 * 引用直接失效；而同一行的图片和视频用的是相对笔记的 `![](./...)`。同一次
 * 剪藏里两种语法并存，用户点开音频是死链，点开图片却正常——这种不一致不会
 * 报错，只会静默地少一个能听的附件。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = process.env.EXT_DIR || path.resolve(".");
/* THEPAPER_SRC 可以指到一份改过的副本，用来验证这组用例确实能抓到旧实现 */
const source = fs.readFileSync(process.env.THEPAPER_SRC || path.join(EXT, "content", "thepaper.js"), "utf8");
const rnSource = fs.readFileSync(path.join(EXT, "js", "rn-format.js"), "utf8");

/* ---------- 只桩 deliver 依赖到的东西 ---------- */
const sent = [];
const chrome = {
  runtime: {
    sendMessage: async (message) => {
      sent.push(message);
      /* 默认全成功；测试可以塞 fails 让指定文件失败。用 match 正则而不是
       * 写死文件名——真实文件名带着当天日期，钉死只会让测试定期自己挂掉。 */
      const fails = chrome.__fails || [];
      const failed = [];
      for (const file of message.data.files || []) {
        const hit = fails.find((f) => (f.match ? f.match.test(file.filename) : f.filename === file.filename));
        if (hit) failed.push({ filename: file.filename, error: hit.error });
      }
      return { done: (message.data.files || []).length - failed.length, failed, cancelled: false };
    },
  },
  __fails: [],
};

const ctx = vm.createContext({
  console,
  URL,
  Date,
  Set,
  Map,
  Number,
  String,
  Array,
  JSON,
  Math,
  Promise,
  TextEncoder,
  chrome,
  BATCH: 8,
  MAX_MEDIA: 300,
  /* deliver 里按扩展名落盘；真实 mediaExt 是启发式的，这里给确定映射 */
  mediaExt: (url, kind) => (kind === "audio" ? ".mp3" : kind === "video" ? ".mp4" : ".jpg"),
  fetchComments: async () => ({ list: [], errors: [] }),
  document: { createElement: () => ({}) },
});
ctx.globalThis = ctx;
/* 用真 rn-format.js，别自己手搓 RN——桩比真实现宽松的话，测试什么都守不住 */
vm.runInContext(rnSource, ctx);
/* thepaper.js 第 18 行是 `const RN = globalThis.__RN;`，抠出来的 deliver 函数体
 * 也指着这个裸名，所以得在沙箱里补上同一个绑定 */
vm.runInContext("const RN = globalThis.__RN;", ctx);

/* 从真实源码里抠 deliver 整个函数体。
 * 注意不能直接找第一个 "{"——形参里的默认值 `options = {}` 就带大括号，
 * 得先跳过参数列表，再从参数表之后找函数体。 */
function extract(name, text) {
  const start = text.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let i = text.indexOf("(", start);
  let paren = 0;
  for (; i < text.length; i++) {
    if (text[i] === "(") paren++;
    else if (text[i] === ")" && --paren === 0) break;
  }
  let depth = 0;
  i = text.indexOf("{", i);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}

vm.runInContext(extract("deliver", source) + "\nglobalThis.__deliver = deliver;", ctx);
const deliver = ctx.__deliver;

const mediaExt = (url, kind) => (kind === "audio" ? ".mp3" : kind === "video" ? ".mp4" : ".jpg");

let bad = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (!cond) {
    bad++;
    if (extra) console.log("        " + extra);
  }
};

/* [1] 三种媒体混在一起：引用语法必须一致 */
{
  sent.length = 0;
  chrome.__fails = [];
  const info = {
    title: "测试",
    nick: "作者",
    time: "2026-01-01",
    id: "1",
    body: "开头\n\n\u00000\u0000\n\n中间\n\n\u00001\u0000\n\n结尾\n\n\u00002\u0000\n尾",
    media: [
      { url: "https://img.example/a.jpg", kind: "image" },
      { url: "https://img.example/b.mp4", kind: "video" },
      { url: "https://img.example/c.mp3", kind: "audio" },
    ],
    unsupported: 0,
    truncated: false,
  };
  /* mediaExt 在真实文件里是另一个函数，这里 map 时直接按 kind 补扩展名 */
  const result = await deliver(info, null, { withMedia: true });
  const body = sent.find((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown"));
  const md = body ? body.data.files.find((f) => f.mime === "text/markdown").text : "";

  check("[1] 音频不再用 wikilink", !md.includes("![["), md.match(/!\[\[.*?\]\]/)?.[0] || "");
  /* 音视频共用一个编号序列（视频 1、音频 2），所以只断言语义不钉死数字 */
  check("[1] 音频写成标准引用", /!\[音频 \d+\]\(\.\/media\/[^)\s]*\.mp3\)/.test(md), md.split("\n").filter((l) => l.includes("音频")).join(" | "));
  check("[1] 图片仍写标准引用", /!\[1\]\(\.\/images\//.test(md), md.split("\n").filter((l) => l.includes("![1]")).join(" | "));
  check("[1] 视频仍写标准引用", /!\[视频 \d+\]\(\.\/media\//.test(md), md.split("\n").filter((l) => l.includes("视频")).join(" | "));
  check("[1] 三种媒体都出现在正文里", (md.match(/!\[/g) || []).length === 3, `引用数=${(md.match(/!\[/g) || []).length}`);
}

/* [2] 音频下载失败：引用要撤掉，并留一句说明 */
{
  sent.length = 0;
  chrome.__fails = [{ match: /\.mp3$/, error: "FILE_NO_SPACE" }];
  const info = {
    title: "测试",
    nick: "作者",
    time: "2026-01-01",
    id: "2",
    body: "正文\n\n\u00000\u0000\n尾",
    media: [{ url: "https://img.example/c.mp3", kind: "audio" }],
    unsupported: 0,
    truncated: false,
  };
  await deliver(info, null, { withMedia: true });
  const body = sent.find((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown"));
  const md = body ? body.data.files.find((f) => f.mime === "text/markdown").text : "";
  check("[2] 失败的音频不留悬空引用", !md.includes("![音频"), md);
  check("[2] 失败要有说明", md.includes("未能保存"), md);
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 澎湃媒体引用语法统一，失败时不留悬空链接");
process.exit(bad ? 1 : 0);
