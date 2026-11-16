/* ABBS 公开帖实页回归。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const target = process.argv[2] || "https://www.abbs.com.cn/bbs/post/view?bid=52&id=341741224&sty=1&tpg=1&age=100";
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failed = true;
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("PAGEERROR " + error.message));
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
  await page.waitForSelector("tr.odd span.javascript", { timeout: 20000 });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/dom-to-md.js", "content/abbs.js"]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = '.xhx-dz-dock[data-xhx-site="abbs"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-go[data-comments="1"]');
  await page.waitForFunction(() => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")), null, { timeout: 60000 });
  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  if (!md) throw new Error("没有产出 Markdown");
  const refs = md.text.match(/!\[\d+\]\(/g) || [];
  const checks = [
    ["来源、作者和时间", md.text.startsWith("---\n来源: ABBS建筑论坛\n作者: 贴心默契\n时间: 2023-04-12_19:01:00")],
    ["正文保留楼主内容", md.text.includes("SHINING-SNT逆风前行") && md.text.includes("sntvisual.com")],
    ["评论与分页合并", md.text.includes("## 评论") && /\d+\. \*\*[^*]+\*\*/.test(md.text)],
    ["正文图片使用 HTTPS", media.length > 0 && media.every((f) => f.url.startsWith("https://"))],
    ["图片引用数等于媒体数", refs.length === media.length],
    ["正文无未替换占位符", !md.text.includes("\u0000")],
  ];
  console.log(`图片 ${media.length}；Markdown ${md.filename}`);
  for (const [name, ok] of checks) console.log((ok ? "  ✓ " : "  ✗ ") + name);
  failed = checks.some(([, ok]) => !ok);
  console.log(failed ? "✗ 有断言未通过" : "✓ 全部通过");
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
