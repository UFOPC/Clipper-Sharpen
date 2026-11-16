/* ArchDaily + 谷德真实项目回归：只拦截下载消息，不写下载目录。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
const pw = await import(process.env.PW ? pathToFileURL(path.resolve(process.env.PW)).href : "playwright");
const { chromium } = pw.default ?? pw;
const extDir = process.env.EXT_DIR || path.resolve(".");
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const failures = [];

function check(condition, name) {
  console.log((condition ? "  ✓ " : "  ✗ ") + name);
  if (!condition) failures.push(name);
}

async function run(target, key, scripts, readySelector, verify, options = {}) {
  const page = await browser.newPage();
  await page.exposeFunction("__fetchText", async (url) => {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, text: await response.text() };
  });
  page.on("pageerror", (error) => console.error("PAGEERROR " + key + " " + error.message));
  page.on("console", (msg) => { if (msg.text().startsWith("ArchDaily expand")) console.log(msg.text()); });
  await page.addInitScript(() => {
    window.__SENT = [];
    window.chrome = {
      runtime: {
        getURL: (p) => location.origin + "/" + p,
        sendMessage: async (msg) => {
          window.__SENT.push(msg);
          if (msg?.type === "fetchText") return window.__fetchText(msg.data.url);
          const files = msg?.data?.files || [];
          return { done: files.length, failed: [], cancelled: false };
        },
      },
      storage: { local: { get: (keys, cb) => cb({}), set: () => {} } },
    };
  });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(readySelector, { timeout: 20000 });
  for (const file of ["content/discuz.css", "js/rn-format.js", "content/clip-common.js", "content/dom-to-md.js", ...scripts]) {
    if (file.endsWith(".css")) await page.addStyleTag({ path: path.join(extDir, file) });
    else await page.addScriptTag({ path: path.join(extDir, file) });
  }
  const dock = `.xhx-dz-dock[data-xhx-site="${key}"]`;
  await page.waitForSelector(dock + " .xhx-dz-btn", { timeout: 10000 });
  await page.hover(dock + " .xhx-dz-btn");
  const count = await page.textContent(dock + " .xhx-dz-key .cnt");
  if (key === "archdaily") {
    const lines = await page.locator(dock + " .xhx-dz-key .xhx-dz-count-line").allTextContents();
    check(lines.length === 2 && /^正文\d+张$/.test(lines[0]) && /^图库\d+张$/.test(lines[1]), "ArchDaily 上方只统计正文与图库图片");
    const rightEdges = await page.locator(dock + " .xhx-dz-count-line:has(span + span) > span:last-child").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().right)));
    check(rightEdges.length >= 2 && rightEdges.every((right) => right === rightEdges[0]), "ArchDaily 两行“张”字右边缘对齐");
    const numberLayout = await page.locator(dock + " .xhx-dz-count-number").evaluateAll((nodes) => nodes.map((node) => ({
      width: Math.round(node.getBoundingClientRect().width),
      unitGap: Math.round(node.nextElementSibling.getBoundingClientRect().left - node.getBoundingClientRect().right),
    })));
    check(numberLayout.length >= 2 && numberLayout.every((item) => item.width === numberLayout[0].width && item.unitGap === 0), "ArchDaily 数字列等宽且单位紧跟数字");
    const positions = await page.locator(dock + " .xhx-dz-key:has(.xhx-dz-label)").evaluate((key) => {
      const label = key.querySelector(".xhx-dz-label").getBoundingClientRect();
      const count = key.querySelector(".cnt").getBoundingClientRect();
      return { gap: Math.round(count.left - label.right), topDelta: Math.abs(label.top - count.top) };
    });
    check(positions.gap === 0 && positions.topDelta < 2, "ArchDaily“图片：”横排且与正文无额外间距");
  }
  if (key === "gooood") {
    const videoRow = page.locator(dock + " [data-video-row]");
    check(await videoRow.isVisible(), "谷德显示独立视频开关");
    check((await videoRow.locator("button").allTextContents()).join("/") === "下载/跳过", "谷德视频提供下载与跳过");
    if (options.skipVideo) await videoRow.locator('button[data-value="0"]').click();
  }
  const lowerVideoRow = page.locator(dock + " [data-video-row]");
  if (await lowerVideoRow.isVisible()) {
    check(/^\d+ 个$/.test((await lowerVideoRow.locator(".cnt").textContent()).trim()), "音视频数量显示在下方开关行");
  }
  await page.click(dock + ' .xhx-dz-go[data-comments="0"]');
  await page.waitForFunction(() => window.__SENT.some((m) => m.type === "downloadFiles" && m.data.files.some((f) => f.mime === "text/markdown")), null, { timeout: 45000 });
  const files = await page.evaluate(() => window.__SENT.filter((m) => m.type === "downloadFiles").flatMap((m) => m.data.files));
  const md = files.find((f) => f.mime === "text/markdown");
  const media = files.filter((f) => f.url);
  if (!md) throw new Error(key + " 没有产出 Markdown");
  console.log(`${key} 首屏 ${count}；最终 ${media.length} 张；${md.filename}`);
  verify(md, media, (md.text.match(/!\[\d+\]\(/g) || []).length);
  await page.close();
}

try {
  await run(
    "https://www.archdaily.cn/zh/1040231/shen-gang-gong-zuo-shi-kraft-architects",
    "archdaily",
    ["content/archdaily.js"],
    "#single-content",
    (md, media, refs) => {
      if (media.length < 20) console.log("ArchDaily 首项目注记", md.text.split("\n").filter((line) => line.startsWith("> ")).join(" | "));
      check(md.text.startsWith("---\n来源: ArchDaily\n"), "ArchDaily 来源正确");
      check(md.text.includes("神冈（Kamioka）") && (md.text.includes("刺槐") || md.text.includes("正文扩展读取失败")), "ArchDaily 正文完整或保留明确失败注记");
      check(media.length >= 20 && media.every((f) => f.url.includes("/large_jpg/")), "ArchDaily 图库使用大图");
      check(media.some((f) => f.filename.includes("/gallery/")) && md.text.includes("## 项目图库"), "ArchDaily 图库独立目录与小节");
      check(refs === media.length, "ArchDaily 引用数等于图片数");
      check(!md.text.includes("猜你喜欢"), "ArchDaily 剔除推荐内容");
    }
  );

  await run(
    "https://www.archdaily.com/zh/1188124/santo-antonio-xiao-xue-gai-zao-yu-xian-dai-hua-sheng-ji-xiang-mu-bfj-arquitectos?ad_content=1188124&ad_medium=widget&ad_name=featured_loop_main",
    "archdaily",
    ["content/archdaily.js"],
    "#single-content",
    (md, media, refs) => {
      check(md.text.includes("该学校建于20世纪50年代初"), "ArchDaily 新项目正文正确");
      check(media.length >= 27 && media.every((f) => f.url.includes("/large_jpg/")), `ArchDaily 新项目图库完整（${media.length} 张）`);
      check(media.some((f) => f.filename.includes("/gallery/")) && md.text.includes("## 项目图库"), "ArchDaily 新项目独立 gallery 目录");
      check(refs === media.length, "ArchDaily 新项目引用数一致");
    }
  );

  await run(
    "https://www.archdaily.com/zh/1188195/la-jin-yu-tian-kong-de-ju-chi-4zuo-tian-wen-guan-yu-tian-wen-tai?ad_campaign=normal-tag",
    "archdaily",
    ["content/archdaily.js"],
    "#single-content",
    (md, media) => {
      const audio = media.filter((f) => f.filename.includes("/media/") && f.filename.endsWith(".mp3"));
      check(audio.length === 1 && audio[0].url.includes("/audio-preview-stream"), "ArchDaily 保存公开 MP3 预览");
      check(md.text.includes("## 音频预览") && md.text.includes("![音频预览](./media/"), "ArchDaily 音频预览写入正文");
      check(md.text.includes("完整音频需页面授权"), "ArchDaily 明确标注音频授权范围");
    }
  );

  await run(
    "https://www.archdaily.com/zh/1188150/de-maasbode-jia-ting-mo-tian-da-lou-van-bergen-kolpa-architects",
    "archdaily",
    ["content/archdaily.js"],
    "#single-content",
    (md, media) => {
      check(md.text.includes("https://www.youtube.com/watch?v=oSNqN1iM6nM"), "ArchDaily 保留 YouTube 原链接");
      check(md.text.includes("未下载视频文件") && !media.some((f) => f.filename.includes("/media/")), "ArchDaily 第三方视频不伪造成本地文件");
    }
  );

  await run(
    "https://www.gooood.cn/office-fact-pills-architects.htm",
    "gooood",
    ["content/gooood.js"],
    ".entry-content-shell",
    (md, media, refs) => {
      const videos = media.filter((f) => f.filename.includes("/media/"));
      check(md.text.includes("OFFICE真相"), "谷德视频项目正文正确");
      check(videos.length === 1 && videos[0].url.includes(".mp4?"), "谷德视频项目解析出 MP4");
      check(md.text.includes("## 视频") && md.text.includes("![视频 1](./media/"), "谷德视频项目保留播放引用");
    }
  );

  await run(
    "https://www.gooood.cn/office-fact-pills-architects.htm",
    "gooood",
    ["content/gooood.js"],
    ".entry-content-shell",
    (md, media) => {
      check(media.length > 0 && media.every((f) => f.filename.includes("/images/")), "跳过视频仍保存图片");
      check(!md.text.includes("![视频") && !md.text.includes("## 视频"), "跳过视频不残留视频小节或引用");
    },
    { skipVideo: true }
  );

  await run(
    "https://www.gooood.cn/en/half-photography-studio-by-wumichi-architects.htm",
    "gooood",
    ["content/gooood.js"],
    ".entry-content-shell",
    (md, media, refs) => {
      const images = media.filter((f) => f.filename.includes("/images/"));
      const videos = media.filter((f) => f.filename.includes("/media/"));
      check(md.text.startsWith("---\n来源: 谷德设计网\n作者: Wumichi Architects\n"), "谷德来源与作者正确");
      check(md.text.includes("项目背景") && md.text.includes("Half空间"), "谷德正文完整");
      check(images.length >= 20 && images.every((f) => f.url.startsWith("https://oss.gooood.cn/") && !/-\d+x\d+\.jpg$/.test(f.url)), "谷德图片去掉尺寸后缀");
      check(refs === images.length, "谷德图片引用数一致");
      check(videos.length === 1 && videos[0].url.endsWith(".mp4") === false && videos[0].url.includes(".mp4?"), "谷德 iframe 解析为 MP4");
      check(md.text.includes("## 视频") && md.text.includes("![视频 1](./media/"), "谷德视频写入正文引用");
      check(!md.text.includes("广告"), "谷德剔除广告内容");
    }
  );
} catch (error) {
  console.error("✗ " + String(error?.stack || error));
  failures.push(String(error?.message || error));
} finally {
  await browser.close();
}
console.log(failures.length ? `✗ ${failures.length} 项未通过` : "✓ 全部通过");
process.exit(failures.length ? 1 : 0);
