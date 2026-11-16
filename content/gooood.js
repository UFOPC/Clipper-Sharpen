/* 谷德设计网项目页：safe-html 正文、项目图与 CDN 原尺寸图片。 */
(() => {
  const MATCH = /^\/(?:en\/)?([a-z0-9-]+)\.htm$/i;
  const squash = globalThis.__XHX_DOM.squash;

  function meta(doc, name) {
    return squash(doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content"));
  }

  function originalImage(raw, base) {
    try {
      const url = new URL(raw || "", base);
      if (url.hostname !== "oss.gooood.cn") return "";
      url.pathname = url.pathname.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp)$)/i, "");
      return url.href;
    } catch (error) { return ""; }
  }

  function read(doc, loc) {
    const match = MATCH.exec(loc.pathname);
    const root = doc.querySelector(".entry-content-shell .safe-html") || doc.querySelector(".entry-content-shell");
    if (!match || !root) return null;
    const title = squash(doc.querySelector("h1.entry-title")?.textContent) || meta(doc, "og:title").replace(/\s*\|\s*谷德设计网.*$/, "");
    const stamp = meta(doc, "article:published_time");
    const parsed = Date.parse(stamp || "");
    const { body, images } = globalThis.__XHX_DOM.walk(root, {
      base: loc.href,
      imageUrl(img) {
        const raw = img.getAttribute("data-src") || img.closest("a.article-image-link")?.getAttribute("href") || img.getAttribute("src") || "";
        return originalImage(raw, loc.href);
      },
    });
    const hero = originalImage(doc.querySelector(".entry-hero-image")?.getAttribute("src") || "", loc.href);
    if (hero && !images.includes(hero)) images.unshift(hero);
    const fullBody = (hero ? "\u00000\u0000\n\n" : "") + body;
    if (!title || (!fullBody && !images.length)) return null;
    const videoIds = [...new Set([...root.querySelectorAll("iframe")]
      .map((iframe) => /[?&]vid=([a-z0-9]+)/i.exec(iframe.getAttribute("src") || "")?.[1])
      .filter(Boolean))];
    return {
      id: match[1],
      title,
      nick: meta(doc, "article:author") || "gooood",
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body: fullBody,
      images,
      videos: [],
      videoIds,
      comments: [],
      tags: [],
      url: loc.origin + loc.pathname,
      warnings: [],
    };
  }

  async function resolveTencent(id) {
    const api = "https://vv.video.qq.com/getinfo?vids=" + encodeURIComponent(id) + "&platform=101001&charge=0&otype=json";
    const response = await chrome.runtime.sendMessage({ type: "fetchText", data: { url: api } });
    if (!response?.ok) throw new Error(response?.error || "HTTP " + response?.status);
    const payload = JSON.parse(String(response.text || "").replace(/^QZOutputJson=/, "").replace(/;\s*$/, ""));
    const item = payload?.vl?.vi?.[0];
    if (!item || item.drm) throw new Error("无公开 MP4 或内容受 DRM 保护");
    const base = item.ul?.ui?.[0]?.url;
    if (!base || !item.fn || !item.fvkey) throw new Error("视频地址字段不完整");
    const url = new URL(base + item.fn);
    url.protocol = "https:";
    url.searchParams.set("vkey", item.fvkey);
    return url.href;
  }

  async function expand(initial) {
    const ids = initial.videoIds || [];
    if (!ids.length) return initial;
    initial.videos = [];
    let failed = 0;
    for (const id of ids) {
      try {
        const url = await resolveTencent(id);
        if (!initial.videos.length) initial.body += "\n\n## 视频\n\n";
        initial.videos.push(url);
        initial.body += `\u0001${initial.videos.length - 1}\u0001\n\n`;
      } catch (error) {
        failed++;
      }
    }
    if (failed) initial.warnings.push(`有 ${failed} 个腾讯 iframe 视频未能解析，未下载。`);
    return initial;
  }

  globalThis.__XHX_CLIP.mount({ key: "gooood", source: "谷德设计网", match: MATCH, read, expand, comments: false });
})();
