/* 色影无忌主站文章实页回归。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const target = process.argv[2] || "https://vision.xitek.com/news/202602/02-370406.html";
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failed = true;
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("PAGEERROR " + error.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("CONSOLE " + msg.text()); });
  await page.addInitScript(() => {
    window.__SENT = [];
    window.chrome = {
      runtime: {
        getURL: (p) => location.origin + "/" + p,
        sendMessage: async (msg) => {
          window.__SENT.push(msg);
          const files = msg?.data?.files || [];
          return { done: files.length, failed: [], cancelled: false };
        },
      },
      storage: { local: { get: (keys, cb) => cb({}), set: () => {} } },
    };
  });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".sam_body", { timeout: 20000 });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/dom-to-md.js", "content/xitek.js"]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = '.xhx-dz-dock[data-xhx-site="xitek"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  await page.hover(dock + " .xhx-dz-btn");
  const count = await page.textContent(dock + " .xhx-dz-key .cnt");
  await page.click(dock + ' .xhx-dz-go[data-comments="0"]');
  await page.waitForFunction(() => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")), null, { timeout: 15000 });
  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  if (!md) throw new Error("没有产出 Markdown");
  const refs = md.text.match(/!\[\d+\]\(/g) || [];
  const plain = md.text.replace(/\*\*/g, "");
  const checks = [
    ["来源与发布时间", md.text.startsWith("---\n来源: 色影无忌\n") && md.text.includes("时间: 2026-02-02_")],
    ["正文完整且剔除推荐", plain.includes("【活动主题】冬日交响") && plain.includes("【特别说明】") && !plain.includes("大家都在看")],
    ["两张正文原图", media.length === 2 && media.every((f) => /^https:\/\/cmscdn\.xitek\.com\/uploads\//.test(f.url))],
    ["图片引用数等于媒体数", refs.length === media.length],
    ["不提供虚假回复按钮", await page.locator(dock + ' .xhx-dz-go[data-comments="1"]').count() === 0],
  ];
  console.log(`页面图片 ${count}；Markdown ${md.filename}`);
  for (const [name, ok] of checks) console.log((ok ? "  ✓ " : "  ✗ ") + name);
  failed = checks.some(([, ok]) => !ok);
  console.log(failed ? "✗ 有断言未通过" : "✓ 全部通过");
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
