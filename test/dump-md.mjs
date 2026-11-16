/* 把真实快照跑出来的 Markdown 原样抄到 test/golden/<站点>.md。
 *
 *   node test/dump-md.mjs          写基准
 *   node test/dump-md.mjs --check  与已存基准逐字符比对
 *
 * 为什么要有这个：抽共享 walker（把 6 份重复实现收敛成一份）是个纯重构，
 * 唯一能证明「行为没变」的证据就是重构前后 md 完全一致。fixtures 里的页面
 * 是真快照（见 real-fixtures.mjs 的说明），比合成 DOM 有说服力。
 *
 * 基准不入库也没关系：--check 在没有基准时只打警告，不判红。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* smzdm 的正文图全在 am.zdmimg.com，且它的 walkBody 要真的取到图才补占位符。
 * 外网被 route.abort 掉，所以起一个本地图片服务顶上——和 smzdm-run.mjs 同一套办法。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
const imgServer = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const body = /\.png/i.test(p) ? PNG : JPG;
  res.writeHead(200, {
    "Content-Type": /\.png/i.test(p) ? "image/png" : "image/jpeg",
    "Content-Length": body.length,
  });
  res.end(body);
});
await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
const IMG_BASE = `http://127.0.0.1:${imgServer.address().port}`;

const PW_DEFAULT =
  "C:/Users/China/.workbuddy-ai/binaries/node/workspace/node_modules/playwright/index.js";
const pw = await import(pathToFileURL(path.resolve(process.env.PW || PW_DEFAULT)).href);
const { chromium } = pw.default ?? pw;

const EXT = process.env.EXT_DIR || path.resolve(".");
const BROWSER =
  process.env.PW_EXE ||
  "C:/Users/China/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";

const GOLDEN = path.join(EXT, "test", "golden");
const check = process.argv.includes("--check");

/* 每一站：快照文件、页面地址、样式、要注入的脚本（依赖序）、胶囊与动作按钮选择器。
 * dom-to-md.js 是共享的正文序列化层，豆瓣/派早/值得买都走它，注入序必须在站点脚本之前——
 * 与 manifest.content_scripts.js 数组的顺序保持一致。 */
const SITES = [
  {
    name: "douban",
    fixture: "douban-topic-502558660.html",
    url: "https://www.douban.com/topic/502558660/",
    css: "douban.css",
    js: ["dom-to-md.js", "douban.js"],
    entry: ".db-xhx-entry",
    slot: ".db-xhx-slot",
    act: ".db-xhx-act",
  },
  {
    name: "sspai",
    fixture: "sspai-117510.html",
    url: "https://sspai.com/post/117510",
    css: "sspai.css",
    js: ["dom-to-md.js", "sspai.js"],
    entry: ".sspai-xhx-entry",
    slot: ".sspai-xhx-slot",
    act: '.sspai-xhx-act[data-comments="0"]',
  },
  {
    name: "smzdm",
    fixture: "smzdm-a4qpgkgx.html",
    url: "https://post.smzdm.com/p/a4qpgkgx/",
    css: "smzdm.css",
    js: ["dom-to-md.js", "smzdm.js"],
    entry: ".xhx-zdm-entry",
    slot: ".xhx-zdm-slot",
    act: '.xhx-zdm-act[data-comments="0"]',
    /* 只换图片域名，页面结构保持原样 */
    rewrite: (html) => html.replace(/https:\/\/am\.zdmimg\.com\//g, IMG_BASE + "/"),
  },
  {
    name: "xiachufang",
    fixture: "xiachufang-107357520.html",
    url: "https://www.xiachufang.com/recipe/107357520/",
    css: "xiachufang.css",
    js: ["xiachufang.js"],
    entry: ".xcf-xhx-entry",
    slot: ".xcf-xhx-slot",
    act: ".xcf-xhx-act",
  },
];

const lacks = [];
const diffs = [];
const browser = await chromium.launch({ executablePath: BROWSER, headless: true });

async function dump(site) {
  const fixture = path.join(EXT, "test", "fixtures", site.fixture);
  if (!fs.existsSync(fixture)) return { skip: "快照缺失" };
  const html = fs
    .readFileSync(fixture, "utf8")
    .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, "");
  const body = site.rewrite ? site.rewrite(html) : html;

  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__SENT = [];
    window.chrome = {
      runtime: {
        getURL: (p) => location.origin + "/" + p,
        sendMessage: async (msg) => {
          if (msg && msg.type === "fetchMedia") {
            return { ok: true, type: "image/jpeg", base64: window.__FAKE_JPEG };
          }
          window.__SENT.push(msg);
          const files = (msg && msg.data && msg.data.files) || [];
          return { done: files.length, failed: [], cancelled: false };
        },
      },
      storage: { local: { get: (_k, cb) => cb({}), set: () => {} } },
    };
    window.__FAKE_JPEG =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  });
  await page.route("**/*", (route) => route.abort());
  await page.route(site.url, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body })
  );
  /* smzdm 的图要真的回来，否则它按「取不到图」走另一条分支，基准就录错了 */
  await page.route(IMG_BASE + "/**", (route) => route.continue());

  try {
    await page.goto(site.url, { waitUntil: "commit", timeout: 30000 });
    await page.addStyleTag({ path: path.join(EXT, "content", site.css) });
    await page.addScriptTag({ path: path.join(EXT, "js", "rn-format.js") });
    for (const item of site.js) {
      await page.addScriptTag({ path: path.join(EXT, "content", item) });
    }
    await page.waitForSelector(site.entry, { timeout: 15000 });
    await page.hover(site.slot);
    /* 用页面内的 DOM 点击，不用 page.click：真实鼠标从胶囊挪到按钮上会触发
     * mouseleave，面板当场收起来，点击就落到空气里（smzdm 就是这么卡的）。 */
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !!(el && el.offsetParent !== null);
      },
      site.act,
      { timeout: 5000 }
    );
    await page.$eval(site.act, (el) => el.click());
    await page.waitForFunction(
      () =>
        window.__SENT.some(
          (m) =>
            m.type === "downloadFiles" &&
            (m.data.files || []).some((f) => f.mime === "text/markdown")
        ),
      null,
      { timeout: 30000 }
    );
    const files = (await page.evaluate(() => window.__SENT))
      .filter((m) => m.type === "downloadFiles")
      .flatMap((m) => m.data.files || []);
    const md = files.find((f) => f.mime === "text/markdown");
    return md ? { text: md.text } : { skip: "没产出 markdown" };
  } catch (error) {
    return { skip: "跑失败：" + String((error && error.message) || error).split("\n")[0] };
  } finally {
    await page.close();
  }
}

for (const site of SITES) {
  const result = await dump(site);
  if (result.skip) {
    lacks.push(`${site.name}（${result.skip}）`);
    console.log(`  skip  ${site.name}：${result.skip}`);
    continue;
  }
  const file = path.join(GOLDEN, site.name + ".md");
  if (check) {
    if (!fs.existsSync(file)) {
      lacks.push(`${site.name}（无基准）`);
      console.log(`  warn  ${site.name}：没有基准文件，先跑一次不带 --check`);
      continue;
    }
    const want = fs.readFileSync(file, "utf8");
    if (want === result.text) {
      console.log(`  PASS  ${site.name}：与实际输出逐字符一致（${result.text.length} 字符）`);
    } else {
      diffs.push(site.name);
      /* 只打第一处差异，整篇 diff 太长没人看 */
      let i = 0;
      while (i < want.length && i < result.text.length && want[i] === result.text[i]) i++;
      console.log(`  FAIL  ${site.name}：第 ${i} 字符起不一致`);
      console.log(`        基准「${JSON.stringify(want.slice(i, i + 60))}」`);
      console.log(`        实际「${JSON.stringify(result.text.slice(i, i + 60))}」`);
    }
  } else {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, result.text, "utf8");
    console.log(`  写入  ${site.name}.md（${result.text.length} 字符）`);
  }
}

await browser.close();
/* 本地图片服务不关，事件循环就一直在，node 永远退不出去（挂过一次，记着） */
imgServer.close();
if (diffs.length) {
  console.log(`\n✗ ${diffs.length} 站输出变了：${diffs.join(" / ")}`);
  process.exit(1);
}
if (lacks.length) console.log(`\n⚠ 跳过 ${lacks.length} 站：${lacks.join("；")}`);
else console.log(check ? "\n✓ 全部与基准一致" : "\n✓ 基准已写入");
