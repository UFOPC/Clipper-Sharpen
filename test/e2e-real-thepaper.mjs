/* 澎湃新闻适配端到端：真实文章页 → 注入适配器 → 点剪藏 → 校验下载清单。
 *
 *   PW=… PW_EXE=… node test/e2e-real-thepaper.mjs [文章URL]
 *
 * 默认样例含正文、原图、粗体、链接、标签、播客与听全文；另验评论/回复、失败清理与纯视频页。
 * 测试只拦截消息，不把文章或媒体写入下载目录。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;

const target = process.argv[2] || "https://www.thepaper.cn/newsDetail_forward_34440595";
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failed = true;

try {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await page.addInitScript(() => {
    window.__SENT = [];
    window.__STORE = {};
    window.chrome = {
      runtime: {
        getURL: (p) => location.origin + "/" + p,
        sendMessage: async (msg) => {
          window.__SENT.push(msg);
          const files = msg?.data?.files || [];
          if (window.__FAIL_MEDIA && files.some((f) => f.url)) {
            return {
              done: 0,
              failed: files.map((f) => ({ filename: f.filename, error: "NETWORK_FAILED" })),
              cancelled: false,
            };
          }
          return { done: files.length, failed: [], cancelled: false };
        },
      },
      storage: {
        local: {
          get: (keys, cb) => cb(window.__STORE || {}),
          set: () => {},
        },
      },
    };
  });

  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('div[class*="cententWrap__"]', { timeout: 20000 });
  await page.addStyleTag({ path: path.join(extDir, "content/discuz.css") });
  await page.addScriptTag({ path: path.join(extDir, "js/rn-format.js") });
  await page.addScriptTag({ path: path.join(extDir, "content/thepaper.js") });
  const dock = '.xhx-dz-dock[data-xhx-site="thepaper"]';
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });

  await page.hover(dock);
  const count = await page.textContent(dock + " .xhx-dz-key .cnt");
  await page.evaluate((selector) => document.querySelector(selector + " .xhx-dz-btn").click(), dock);
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 15000 }
  );

  const files = await page.evaluate(() =>
    window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files)
  );
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  const images = media.filter((f) => f.filename.includes("/images/"));
  const av = media.filter((f) => f.filename.includes("/media/"));
  if (!md) throw new Error("没有产出 Markdown");

  const checks = [];
  const refs = md.text.match(/!\[[^\]]*\]\(|!\[\[[^\]]+\]\]/g) || [];
  checks.push(["md 路径 <标题目录>/日期_标题_作者.md", /^[^/]+\/\d{4}\.\d{2}\.\d{2}_[^/]+\.md$/.test(md.filename)]);
  checks.push(["frontmatter 来源与真实作者", /^---\n来源: 澎湃新闻\n作者: \S/m.test(md.text)]);
  checks.push(["frontmatter 时间、链接与标签", /时间: \d{4}-\d{2}-\d{2}_/.test(md.text) && /链接: https:\/\/www\.thepaper\.cn\/newsDetail_forward_\d+/.test(md.text) && /tags:\n  - /.test(md.text)]);
  checks.push(["正文有 H1 且保留粗体问答", /^# /m.test(md.text) && md.text.includes("**澎湃新闻：**")]);
  checks.push(["正文长度 ≥ 1000 字", md.text.length > 1000]);
  checks.push(["正文包含首段与末段", md.text.includes("步入2026年的深秋") && md.text.includes("人的再生产")]);
  checks.push(["图片使用 data-src 原图且去掉缩放指令", images.length > 0 && images.every((f) => /^https:\/\/imgpai\.thepaper\.cn\//.test(f.url) && !f.url.includes("x-oss-process"))]);
  checks.push(["图片写入 images/ 目录", images.every((f) => /\/images\/\d{4}\.\d{2}\.\d{2}_[^/]+-\d{2}\.\w+$/.test(f.filename))]);
  checks.push(["播客与听全文音频均写入 media/", av.length === 2 && av.every((f) => /^https:/.test(f.url) && /\.mp3$/.test(f.url) && /\/media\/[^/]+-\d{2}\.mp3$/.test(f.filename))]);
  checks.push(["frontmatter 标记图文+音频", md.text.includes("\n类型: 图文+音频\n")]);
  checks.push(["播客与听全文使用 Obsidian 音频嵌入", (md.text.match(/!\[\[media\/[^\]]+\.mp3\]\]/g) || []).length === 2 && md.text.includes("## 听全文")]);
  checks.push(["正文媒体引用数 == 媒体数", refs.length === media.length]);
  checks.push(["媒体引用为合法相对 URI", refs.length === 0 || /!\[1\]\(\.\/images\//.test(md.text)]);
  checks.push(["正文无未替换占位符", !md.text.includes("\u0000")]);

  /* 正文+回复：合并热评论与新评论，保留一级评论、楼中楼、时间与 IP 属地。 */
  await page.waitForFunction(() => !document.querySelector('.xhx-dz-dock[data-xhx-site="thepaper"] .xhx-dz-btn')?.dataset.busy);
  await page.evaluate(() => (window.__SENT.length = 0));
  await page.mouse.move(0, 0);
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-go[data-comments="1"]');
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 20000 }
  );
  const commentMd = await page.evaluate(() =>
    window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files).find((f) => f.mime === "text/markdown")?.text || ""
  );
  checks.push(["评论区写入 Markdown", commentMd.includes("## 评论") && /\d+\. \*\*匿名|\d+\. \*\*\S+/.test(commentMd)]);
  checks.push(["一级评论与楼中楼均保留", commentMd.includes("**南方小佳人**") && commentMd.includes("- **蔚蓝大观2004**")]);
  checks.push(["评论保留时间与 IP 属地", /2026-11-11 07:32:48 · 广东/.test(commentMd) && /学习了解了/.test(commentMd)]);
  checks.push(["评论接口没有报失败", !commentMd.includes("评论抓取失败") && !commentMd.includes("评论抓取可能不完整")]);

  /* 跳过媒体：只发 md，不发媒体，也不能留下失效引用。 */
  await page.waitForFunction(() => !document.querySelector('.xhx-dz-dock[data-xhx-site="thepaper"] .xhx-dz-btn')?.dataset.busy);
  await page.evaluate(() => (window.__SENT.length = 0));
  await page.mouse.move(0, 0);
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-seg button[data-value="0"]');
  await page.evaluate((selector) => document.querySelector(selector + " .xhx-dz-btn").click(), dock);
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 10000 }
  );
  const skipFiles = await page.evaluate(() =>
    window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files)
  );
  checks.push(["跳过媒体只生成 Markdown", skipFiles.length === 1 && skipFiles[0].mime === "text/markdown"]);
  checks.push(["跳过媒体后无媒体引用", !/!\[[^\]]*\]\(|!\[\[[^\]]+\]\]/.test(skipFiles[0]?.text || "")]);

  /* 所有媒体落盘失败：正文照存，但不能留下任何指向不存在文件的引用。 */
  await page.waitForFunction(() => !document.querySelector('.xhx-dz-dock[data-xhx-site="thepaper"] .xhx-dz-btn')?.dataset.busy);
  await page.evaluate(() => {
    window.__SENT.length = 0;
    window.__FAIL_MEDIA = true;
  });
  await page.mouse.move(0, 0);
  await page.hover(dock + " .xhx-dz-btn");
  await page.click(dock + ' .xhx-dz-seg button[data-value="1"]');
  await page.evaluate((selector) => document.querySelector(selector + " .xhx-dz-btn").click(), dock);
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 10000 }
  );
  const failureMd = await page.evaluate(() =>
    window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files).find((f) => f.mime === "text/markdown")?.text || ""
  );
  checks.push(["媒体失败时正文无失效引用", !/!\[[^\]]*\]\(|!\[\[[^\]]+\]\]/.test(failureMd)]);
  checks.push(["媒体失败写入明确注记", failureMd.includes("有 3 项媒体未能保存") && failureMd.includes("NETWORK_FAILED")]);

  /* 纯视频页没有 cententWrap，必须从 __NEXT_DATA__.content 取 MP4。 */
  await page.goto("https://www.thepaper.cn/newsDetail_forward_34447462", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 20000 });
  await page.addStyleTag({ path: path.join(extDir, "content/discuz.css") });
  await page.addScriptTag({ path: path.join(extDir, "js/rn-format.js") });
  await page.addScriptTag({ path: path.join(extDir, "content/thepaper.js") });
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  /* 纯视频页没有正文容器；定时检查跑过一轮后按钮仍必须可见。 */
  await page.waitForTimeout(1800);
  checks.push(["纯视频页定时检查后按钮不消失", await page.isVisible(dock + " .xhx-dz-btn")]);
  const videoCount = await page.textContent(dock + " .xhx-dz-key .cnt");
  await page.evaluate((selector) => document.querySelector(selector + " .xhx-dz-btn").click(), dock);
  await page.waitForFunction(
    () => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")),
    null,
    { timeout: 15000 }
  );
  const videoFiles = await page.evaluate(() =>
    window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files)
  );
  const videoMd = videoFiles.find((f) => f.mime === "text/markdown");
  const videos = videoFiles.filter((f) => f.url);
  checks.push(["纯视频页显示一项音视频", videoCount.includes("1 音视频")]);
  checks.push(["MP4 使用 HTTPS 并写入 media/", videos.length === 1 && /^https:\/\/cloudvideo\.thepaper\.cn\/.*\.mp4$/.test(videos[0].url) && /\/media\/[^/]+-01\.mp4$/.test(videos[0].filename)]);
  checks.push(["纯视频 frontmatter 与正文引用", videoMd?.text.includes("\n类型: 视频\n") && videoMd.text.includes("![视频 1](./media/")]);

  console.log(`页面媒体计数 ${count}`);
  console.log(`md ${md.filename}`);
  console.log(`媒体 ${media.length}（图片 ${images.length} / 音视频 ${av.length}）${media[0] ? "，示例 " + media[0].filename : ""}`);
  console.log(`纯视频页 MP4 ${videos.length}${videos[0] ? "，示例 " + videos[0].filename : ""}`);
  for (const [name, ok] of checks) console.log((ok ? "  ✓ " : "  ✗ ") + name);
  failed = checks.some(([, ok]) => !ok);
  console.log(failed ? "✗ 有断言未通过" : "✓ 全部通过");
} catch (error) {
  console.error("✗ " + String(error?.stack || error?.message || error));
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
