/* 蜂鸟移动帖实页回归：正文合并、原图、EXIF、分页评论。只拦截消息，不写下载目录。 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const target = process.argv[2] || "https://m.fengniao.com/thread/12092851.html";
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failed = true;

try {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
  });
  await page.addInitScript(() => {
    window.__SENT = [];
    window.__MEDIA_URLS = [];
    window.chrome = {
      runtime: {
        getURL: (p) => location.origin + "/" + p,
        sendMessage: async (msg) => {
          window.__SENT.push(msg);
          if (msg?.type === "fetchMedia") {
            window.__MEDIA_URLS.push(msg.data.url);
            return { ok: true, type: "image/jpeg", base64: "" };
          }
          const files = msg?.data?.files || [];
          return { done: files.length, failed: [], cancelled: false };
        },
      },
      storage: { local: { get: (keys, cb) => cb({}), set: () => {} } },
    };
  });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("ul.detailsPic > li", { timeout: 20000 });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/fengniao.js"]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = '.xhx-dz-dock[data-xhx-site="fengniao"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  await page.hover(dock + " .xhx-dz-btn");
  const count = await page.textContent(dock + " .xhx-dz-key .cnt");
  await page.click(dock + ' .xhx-dz-go[data-comments="1"]');
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 45000 }
  );

  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  const sources = await page.evaluate(() => window.__MEDIA_URLS);
  if (!md) throw new Error("没有产出 Markdown");
  const refs = md.text.match(/!\[\d+\]\(/g) || [];
  const checks = [
    ["来源、作者和时间", md.text.startsWith("---\n来源: 蜂鸟摄影\n作者: ssxj2018\n时间: 2026-08-01_19:05:44")],
    ["正文含标题与 EXIF", md.text.includes("颐和园") && md.text.includes("NIKON Z 7_2") && md.text.includes("光圈：f/16.0")],
    ["分页评论已合并", md.text.includes("## 评论") && md.text.includes("蓝色小提琴") && md.text.includes("走拍健身")],
    ["原图参数保留签名", sources.length === 5 && sources.every((url) => url.includes("imageView2/2/w/0/q/100") && url.includes("auth_key="))],
    ["图片引用数等于媒体数", refs.length === media.length],
    ["正文无未替换占位符", !md.text.includes("\u0000")],
  ];
  console.log(`首屏图片计数 ${count}；跨页图片 ${media.length}；Markdown ${md.filename}`);
  for (const [name, ok] of checks) console.log((ok ? "  ✓ " : "  ✗ ") + name);
  failed = checks.some(([, ok]) => !ok);
  console.log(failed ? "✗ 有断言未通过" : "✓ 全部通过");
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
