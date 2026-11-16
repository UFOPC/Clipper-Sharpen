/* ABBS 新闻 / 专题公开文章实页回归。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const failures = [];

async function run(target, expected) {
  const page = await browser.newPage();
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
  await page.waitForSelector("td.s center b", { timeout: 20000 });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/dom-to-md.js", "content/abbs.js"]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = '.xhx-dz-dock[data-xhx-site="abbs"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-go[data-comments="0"]');
  await page.waitForFunction(() => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")), null, { timeout: 15000 });
  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  const refs = (md?.text.match(/!\[\d+\]\(/g) || []).length;
  const checks = [
    [md?.text.includes(expected.title), expected.title],
    [md?.text.includes(expected.text), "正文内容"],
    [media.length >= expected.images && media.every((f) => f.url.startsWith("https://")), `HTTPS 图片 ${media.length} 张`],
    [refs === media.length, "图片引用数一致"],
    [await page.locator(dock + ' .xhx-dz-go[data-comments="1"]').count() === 0, "无内嵌回复时不显示回复按钮"],
  ];
  for (const [ok, name] of checks) {
    console.log((ok ? "  ✓ " : "  ✗ ") + name);
    if (!ok) failures.push(expected.title + " " + name);
  }
  await page.close();
}

try {
  await run("https://www.abbs.com.cn/news/read.php?cate=3&recid=38549", {
    title: "青木淳设计“连衣裙”LV旗舰店", text: "建筑花边", images: 9,
  });
  await run("https://www.abbs.com.cn/topic/read.php?cate=2&recid=38537", {
    title: "一栋建筑应该持续多久", text: "斯瓦尔巴全球种子库", images: 8,
  });
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
  failures.push(String(error?.message || error));
} finally {
  await browser.close();
}
console.log(failures.length ? `✗ ${failures.length} 项未通过` : "✓ 全部通过");
process.exit(failures.length ? 1 : 0);
