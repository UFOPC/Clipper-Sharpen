/* 蜂鸟桌面帖直接剪藏：不新开页面，跨页原图并排除推荐缩略图。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failed = true;

function html(images, next) {
  return `<!doctype html><title>【有图】【有映画】NANA-蜂鸟网</title><h1>NANA</h1>
  <div class="author">NANA作者</div><span>1楼 2026-11-04 16:07:21</span>
  ${images.map((id, i) => `<div><a href="/forum/pic/slide_12125239_${i + 1}.html"><img src="https://bbs.qn.img-space.com/202611/4/${id}.jpg?imageView2/2/w/800/q/75/ignore-error/1/&auth_key=test"></a></div>`).join("")}
  <a class="bbsImg" href="/thread/other.html"><img src="https://bbs.qn.img-space.com/202611/4/recommend.jpg?imageView2/2/w/400/q/75/ignore-error/1/"></a>
  ${next ? '<a href="/forum/12125239_2.html">下一页</a>' : ""}`;
}

try {
  const page = await browser.newPage();
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
  await page.context().route("https://bbs.fengniao.com/forum/12125239.html", (route) => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8", body: html(["first"], true),
  }));
  await page.context().route("https://bbs.fengniao.com/forum/12125239_2.html", (route) => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8", body: html(["second"], false),
  }));
  await page.context().route("https://bbs.fengniao.com/forum/12125239_p122959760.html", (route) => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8", body: html(["first"], true),
  }));
  await page.goto("https://bbs.fengniao.com/forum/12125239_p122959760.html#post122959760", { waitUntil: "load" });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/fengniao.js"]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = '.xhx-dz-dock[data-xhx-site="fengniao"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { state: "visible" });
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-go[data-comments="0"]');
  await page.waitForFunction(() => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")), null, { timeout: 15000 });
  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const media = files.filter((f) => f.url);
  const md = files.find((f) => f.mime === "text/markdown");
  const sources = await page.evaluate(() => window.__MEDIA_URLS);
  const checks = [
    ["桌面帖直接生成两张跨页图片", media.length === 2],
    ["原图使用 w/0/q/100", sources.every((url) => url.includes("imageView2/2/w/0/q/100"))],
    ["推荐缩略图未混入", media.every((f) => !f.url.includes("recommend"))],
    ["正文无未替换占位符", md && !md.text.includes("\u0000")],
    ["不再新开页面", page.context().pages().length === 1],
  ];
  for (const [name, ok] of checks) console.log((ok ? "  ✓ " : "  ✗ ") + name);
  failed = checks.some(([, ok]) => !ok);
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
} finally {
  await browser.close();
}
console.log(failed ? "✗ 有断言未通过" : "✓ 全部通过");
process.exit(failed ? 1 : 0);
