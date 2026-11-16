/* 取消：共用 clip-common 的 9 个站点必须能中途停下。
 *
 * 这里守的是一件很容易假装做到的事。「取消」在两个地方同时生效：
 *   1. content 侧 deliver 每批开头问一次 shouldStop()——停了就不再取图、
 *      不再发 downloadFiles；
 *   2. background 侧 downloadList 每轮问一次 isCancelled(taskId)——停了就
 *      把手上这批剩下的跳过，并在响应里回 cancelled:true。
 * 只做一处的后果不一样但同样难受：只做 1，后台还在核已建条目，界面说取消了
 * 文件却继续落；只做 2，content 会一直往后台喂新批次，取消变成「每批都白跑」。
 *
 * 还有一条下限：取消之后 Markdown 仍然要写。否则盘上是一堆没有索引的散图，
 * 而且用户看不到「这是半成品」的说明。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = process.env.EXT_DIR || path.resolve(".");
const source = fs.readFileSync(process.env.CLIP_SRC || path.join(EXT, "content", "clip-common.js"), "utf8");
const rnSource = fs.readFileSync(path.join(EXT, "js", "rn-format.js"), "utf8");

const sent = [];
const chrome = {
  runtime: {
    sendMessage: async (message) => {
      sent.push(message);
      /* 后台说「我按取消收尾了」时，deliver 必须立刻停手 */
      if (chrome.__bgCancelAfter && sent.filter((m) => m.type === "downloadFiles").length >= chrome.__bgCancelAfter) {
        return { done: 0, failed: [], cancelled: true };
      }
      return { done: (message.data?.files || []).length, failed: [], cancelled: false };
    },
    getURL: (p) => "chrome-extension://test/" + p,
  },
  __bgCancelAfter: 0,
};

const ctx = vm.createContext({
  console, URL, Date, Set, Map, Number, String, Array, JSON, Math, Promise, TextEncoder,
  chrome,
  BATCH: 8,
  /* clip-common 里两个私有小工具，照抄真实实现（只改文件名扩展名的启发式） */
  extOf: (url) => { const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname); return m ? "." + m[1].toLowerCase().replace("jpeg", "jpg") : ".jpg"; },
  videoExt: (url) => { const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname); return m ? "." + m[1].toLowerCase() : ".mp4"; },
  /* asDataUrl：config.fetchMedia 为假时原样返回，正好不碰网络 */
  asDataUrl: async (config, url) => url,
  document: { createElement: () => ({}) },
});
ctx.globalThis = ctx;
vm.runInContext(rnSource, ctx);
vm.runInContext("const RN = globalThis.__RN;", ctx);

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

let bad = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (!cond) {
    bad++;
    if (extra) console.log("        " + extra);
  }
};

const mkInfo = (count) => ({
  title: "取消测试",
  nick: "作者",
  time: "2026-01-01",
  id: "1",
  url: "https://example.com/p/1",
  body: Array.from({ length: count }, (_, i) => `第${i + 1}段\n\n\u0000${i}\u0000`).join("\n\n") + "\n尾",
  images: Array.from({ length: count }, (_, i) => `https://img.example/${i + 1}.jpg`),
  videos: [],
  comments: [],
  tags: [],
});
const mdOf = () => {
  const hit = sent.find((m) => m.type === "downloadFiles" && (m.data?.files || []).some((f) => f.mime === "text/markdown"));
  return hit ? hit.data.files.find((f) => f.mime === "text/markdown").text : "";
};
const batches = () => sent.filter((m) => m.type === "downloadFiles").length;

/* [1] 一开始就取消：媒体一批都不该发，但 Markdown 仍要写，并交代是半成品 */
{
  sent.length = 0;
  chrome.__bgCancelAfter = 0;
  const result = await deliver({ key: "t", source: "测试站", read: () => null }, mkInfo(20), null, {
    withMedia: true, withVideos: true, withComments: false,
    taskId: "t-1", shouldStop: () => true,
  });
  check("[1] 取消后不再发媒体批次", batches() === 1, `downloadFiles 共 ${batches()} 次（其中 1 次是 md）`);
  check("[1] 返回值标明已取消", result.cancelled === true, JSON.stringify({ cancelled: result.cancelled }));
  check("[1] 一项媒体都没算成功", result.media === 0, `media=${result.media}`);
  const md = mdOf();
  check("[1] Markdown 仍然写盘", !!md, md ? "" : "没有 md");
  check("[1] 留下「已取消」说明", md.includes("已取消"), md.split("\n").filter((l) => l.includes("取消")).join(" | "));
  check("[1] 取消的图不留悬空引用", !md.includes("](. /images"), (md.match(/!\[[^\]]*\]\([^)]*\)/g) || []).join(" | "));
}

/* [2] 跑完第一批后取消：第二批不许再发，已落盘的第一批要留在正文里 */
{
  sent.length = 0;
  chrome.__bgCancelAfter = 0;
  let asked = 0;
  const result = await deliver({ key: "t", source: "测试站", read: () => null }, mkInfo(20), null, {
    withMedia: true, withVideos: true, withComments: false,
    taskId: "t-2",
    /* 第一次问（第 1 批开头）说「继续」，之后一律说「停」——模拟用户在第 1
     * 批落盘之后才点取消 */
    shouldStop: () => ++asked > 1,
  });
  check("[2] 只发了第一批媒体", batches() === 2, `downloadFiles 共 ${batches()} 次（1 批媒体 + 1 次 md）`);
  check("[2] 返回值标明已取消", result.cancelled === true);
  check("[2] 已落盘的 8 张算成功", result.media === 8, `media=${result.media}`);
  const md = mdOf();
  check("[2] 已落盘的图仍有引用", (md.match(/!\[\d+\]\(\.\/images\//g) || []).length === 8,
    `引用数=${(md.match(/!\[\d+\]\(\.\/images\//g) || []).length}`);
  check("[2] 取消说明给出具体项数", /已取消：媒体只保存到第 8 项/.test(md),
    md.split("\n").filter((l) => l.includes("已取消")).join(" | "));
  check("[2] 未落盘的图不留引用", !/!\[(?:9|1\d|20)\]/.test(md),
    (md.match(/!\[\d+\]\(\.\/images\/[^)]*\)/g) || []).slice(-3).join(" | "));
}

/* [3] 后台说取消了（content 没来得及问）：也得停，不能继续喂批次 */
{
  sent.length = 0;
  chrome.__bgCancelAfter = 1;
  let stopFlag = false;
  const result = await deliver({ key: "t", source: "测试站", read: () => null }, mkInfo(40), null, {
    withMedia: true, withVideos: true, withComments: false,
    taskId: "t-3",
    /* content 自己没收到取消指令，只有后台回 cancelled:true */
    shouldStop: () => stopFlag,
  });
  check("[3] 后台回 cancelled 后立刻停手", batches() === 2, `downloadFiles 共 ${batches()} 次（1 批媒体 + 1 次 md）`);
  check("[3] 返回值标明已取消", result.cancelled === true);
  const md = mdOf();
  check("[3] 仍然写 Markdown", !!md);
  check("[3] 后台取消的批次不算成功", result.media === 0, `media=${result.media}`);
  chrome.__bgCancelAfter = 0;
}

/* [4] 不取消时行为不变：全部批次发完、没有「已取消」字样 */
{
  sent.length = 0;
  chrome.__bgCancelAfter = 0;
  const result = await deliver({ key: "t", source: "测试站", read: () => null }, mkInfo(20), null, {
    withMedia: true, withVideos: true, withComments: false,
    taskId: "t-4", shouldStop: () => false,
  });
  check("[4] 未取消时发满批次", batches() === 4, `downloadFiles 共 ${batches()} 次（3 批媒体 + 1 次 md）`);
  check("[4] 未取消时 cancelled 为假", result.cancelled === false, JSON.stringify({ cancelled: result.cancelled }));
  check("[4] 未取消时全部计入成功", result.media === 20, `media=${result.media}`);
  const md = mdOf();
  check("[4] 未取消时不写「已取消」", !md.includes("已取消"));
  check("[4] 20 张图都有引用", (md.match(/!\[\d+\]\(\.\/images\//g) || []).length === 20,
    `引用数=${(md.match(/!\[\d+\]\(\.\/images\//g) || []).length}`);
}

/* [5] taskId 必须逐批带给后台——没带的话后台根本没法登记取消 */
{
  sent.length = 0;
  chrome.__bgCancelAfter = 0;
  await deliver({ key: "t", source: "测试站", read: () => null }, mkInfo(10), null, {
    withMedia: true, withVideos: true, withComments: false,
    taskId: "t-5", shouldStop: () => false,
  });
  const media = sent.filter((m) => m.type === "downloadFiles" && (m.data?.files || []).some((f) => f.url));
  check("[5] 每批都带同一个 taskId",
    media.length > 0 && media.every((m) => m.data.taskId === "t-5"),
    media.map((m) => m.data.taskId).join(","));
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 取消能中途停下，取消后仍留半成品笔记");
process.exit(bad ? 1 : 0);
