/* 色影无忌主站公开文章（vision.xitek.com/news/...）。论坛主域名目前不可达，不在此注入。 */
(() => {
  const MATCH = /^\/news\/(\d{6})\/(\d{2})-(\d+)\.html/;
  const squash = globalThis.__XHX_DOM.squash;

  function read(doc, loc) {
    const match = MATCH.exec(loc.pathname);
    const root = doc.querySelector(".sam_body");
    if (!match || !root) return null;
    const title = squash(doc.querySelector(".sam_title h1")?.textContent) ||
      squash(doc.title).replace(/_影像_色影无忌\s*$/, "");
    const stamp = squash(doc.querySelector(".sam_author .dd_time")?.textContent);
    const parsed = Date.parse(stamp || "");
    const { body, images } = globalThis.__XHX_DOM.walk(root, {
      base: loc.href,
      imageUrl(img) {
        const raw = img.getAttribute("data-original") || img.getAttribute("data-src") ||
          img.closest("a")?.getAttribute("href") || img.getAttribute("src") || "";
        try {
          const url = new URL(raw, loc.href);
          return /^https?:$/.test(url.protocol) && !/loading\.gif|xitek-logo|vision-word|share\/xitek/i.test(url.href) ? url.href : "";
        } catch (error) { return ""; }
      },
    });
    if (!title || (!body && !images.length)) return null;
    return {
      id: match[3],
      title,
      nick: squash(doc.querySelector(".sam_author dt")?.textContent) || "色影无忌",
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body,
      images,
      comments: [],
      url: loc.origin + loc.pathname,
    };
  }

  globalThis.__XHX_CLIP.mount({ key: "xitek", source: "色影无忌", match: MATCH, read, comments: false });
})();
