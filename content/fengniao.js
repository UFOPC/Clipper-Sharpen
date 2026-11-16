/* 蜂鸟摄影移动帖（m.fengniao.com/thread/<id>[_page].html）
 * 楼主图片楼层合并为正文，其他楼层进入评论；最多顺序读取 20 页。
 */
(() => {
  const MATCH = /^\/thread\/(\d+)(?:_(\d+))?\.html/;
  const DESKTOP_MATCH = /^\/forum\/(\d+)(?:_\d+)?(?:_p\d+)?\.html/;
  const MAX_PAGES = 20;
  const squash = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const clean = (value) => String(value || "").replace(/\r/g, "").replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function abs(raw, base) {
    try { return new URL(raw || "", base).href; } catch (error) { return ""; }
  }

  function imageUrl(img, base) {
    const raw = img.getAttribute("data-original") || img.getAttribute("data-src") || img.getAttribute("src") || "";
    const url = abs(raw, base);
    /* 保留 auth_key，只调整站方图片档位；w/0/q/100 已实测为原始尺寸。 */
    return url.replace(/imageView2\/2\/w\/\d+\/q\/\d+/i, "imageView2/2/w/0/q/100");
  }

  function parsePage(doc, loc, offset = 0, seen = new Set()) {
    const match = MATCH.exec(loc.pathname);
    const base = loc.href;
    const floors = [...doc.querySelectorAll("ul.detailsPic > li")];
    if (!match || !floors.length) return null;

    const title = squash(doc.querySelector(".detailHeade h3.font24")?.textContent) ||
      squash(doc.title).replace(/^【图】|_[\s\S]*$|^-蜂鸟网$/g, "");
    const first = floors.find((li) => li.querySelector(".dengji")?.textContent.includes("楼主")) || floors[0];
    const nick = squash(first.querySelector(".profileBox .name")?.textContent);
    const stamp = squash(first.querySelector(".time")?.textContent);
    const parsed = Date.parse(stamp || "");
    const parts = [];
    const images = [];
    const comments = [];

    for (const floor of floors) {
      const author = squash(floor.querySelector(".profileBox .name")?.textContent) || "匿名";
      const time = squash(floor.querySelector(".time")?.textContent);
      const isOp = floor.querySelector(".dengji")?.textContent.includes("楼主");
      const text = clean(floor.querySelector(".title.font16")?.textContent);

      if (isOp) {
        if (text) parts.push(text, "\n\n");
        for (const img of floor.querySelectorAll("ul.imgsBox img")) {
          const url = imageUrl(img, base);
          if (!url) continue;
          const key = new URL(url).pathname;
          if (seen.has(key)) continue;
          seen.add(key);
          images.push(url);
          parts.push("\u0000" + (offset + images.length - 1) + "\u0000", "\n\n");
        }
        const exif = [...floor.querySelectorAll(".intro .inSpan")]
          .map((el) => squash(el.textContent)).filter(Boolean).join("\n");
        if (exif) parts.push(exif, "\n\n");
      } else {
        const quote = clean(floor.querySelector(".replyCont1")?.textContent);
        if (text || quote) comments.push({ author, time, text, quote, replies: [] });
      }
    }

    const nextLink = [...doc.querySelectorAll('a[href*="/thread/"]')]
      .find((a) => a.textContent.trim() === "下一页");
    return {
      id: match[1],
      title,
      nick,
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body: parts.join("").trim(),
      images,
      comments,
      next: nextLink ? abs(nextLink.getAttribute("href"), base) : "",
      pagePath: loc.pathname,
      url: "https://m.fengniao.com/thread/" + match[1] + ".html",
      warnings: [],
    };
  }

  /* 桌面帖不再跳移动页：优先使用作品幻灯链接，兼容宽图节点，排除推荐/回复缩略图。 */
  function parseDesktop(doc, loc, offset = 0, seen = new Set()) {
    const match = DESKTOP_MATCH.exec(loc.pathname);
    if (!match) return null;
    const nodes = [...doc.querySelectorAll('a[href*="/forum/slide_"] img, a[href*="/forum/pic/slide_"] img, img[src*="bbs.qn.img-space.com"]')];
    const images = [];
    const parts = [];
    for (const img of nodes) {
      const link = img.closest("a")?.getAttribute("href") || "";
      const raw = img.getAttribute("data-original") || img.getAttribute("data-src") || img.getAttribute("src") || "";
      const isSlide = /\/forum\/(?:pic\/)?slide_/.test(link);
      const isWide = /imageView2\/2\/w\/(?:0|800|1024|1080|1920)\//i.test(raw);
      if (!isSlide && !isWide) continue;
      if (img.classList.contains("replayImg") || img.closest(".bbsImg")) continue;
      const url = imageUrl(img, loc.href);
      if (!url) continue;
      const key = new URL(url).pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push(url);
      parts.push("\u0000" + (offset + images.length - 1) + "\u0000", "\n\n");
    }
    if (!images.length) return null;
    const stamp = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.exec(doc.body.textContent || "")?.[0] || "";
    const parsed = Date.parse(stamp || "");
    const nick = squash(doc.querySelector(".profileBox .name, .user-name, .username, .author")?.textContent) || "蜂鸟作者";
    const nextLink = [...doc.querySelectorAll("a")].find((a) => a.textContent.trim() === "下一页");
    return {
      id: match[1],
      title: squash(doc.title).replace(/^【有图】|[-_]蜂鸟网.*$/g, ""),
      nick,
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body: parts.join("").trim(),
      images,
      comments: [],
      hasComments: false,
      next: nextLink ? abs(nextLink.getAttribute("href"), loc.href) : "",
      pagePath: loc.pathname,
      url: "https://bbs.fengniao.com/forum/" + match[1] + ".html",
      warnings: [],
    };
  }

  async function fetchPage(url, offset, seen) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const loc = new URL(url);
    const info = DESKTOP_MATCH.test(loc.pathname)
      ? parseDesktop(doc, loc, offset, seen)
      : parsePage(doc, loc, offset, seen);
    if (!info) throw new Error("未识别到帖子楼层");
    return info;
  }

  async function expand(initial) {
    const seen = new Set();
    let info = initial.pagePath === new URL(initial.url).pathname
      ? initial
      : await fetchPage(initial.url, 0, seen);
    if (info === initial) {
      for (const image of initial.images) seen.add(new URL(image).pathname);
    }
    let next = info.next;

    for (let page = 1; page < MAX_PAGES && next; page++) {
      try {
        const more = await fetchPage(next, info.images.length, seen);
        info.body += (info.body && more.body ? "\n\n" : "") + more.body;
        info.images.push(...more.images);
        info.comments.push(...more.comments);
        info.next = more.next;
        next = more.next;
      } catch (error) {
        info.warnings.push(`第 ${page + 1} 页抓取失败（${String(error?.message || error)}），已保留前面页面。`);
        break;
      }
    }
    if (next) info.warnings.push(`仅读取前 ${MAX_PAGES} 页，后续页面未保存。`);
    delete info.next;
    return info;
  }

  globalThis.__XHX_CLIP.mount({
    key: "fengniao",
    source: "蜂鸟摄影",
    match: /^\/(?:thread|forum)\/\d+(?:_\d+)?\.html/,
    read: (doc, loc) => DESKTOP_MATCH.test(loc.pathname) ? parseDesktop(doc, loc) : parsePage(doc, loc),
    expand,
    fetchMedia: true,
  });
})();
