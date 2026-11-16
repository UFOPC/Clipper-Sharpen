/* ArchDaily 中文项目页：等待正文与图库异步加载后剪藏，不绕过订阅限制。 */
(() => {
  const MATCH = /^\/(?:zh|cn)\/(\d+)(?:\/|$)/;
  const squash = globalThis.__XHX_DOM.squash;

  function meta(doc, name) {
    return squash(doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content"));
  }

  function imageUrl(img, loc) {
    const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
    try {
      const url = new URL(raw, loc.href);
      if (url.hostname !== "images.adsttc.com") return "";
      url.pathname = url.pathname.replace(/\/(?:newsletter|medium_jpg|thumb_jpg)\//i, "/large_jpg/");
      return url.href;
    } catch (error) { return ""; }
  }

  function read(doc, loc) {
    const match = MATCH.exec(loc.pathname);
    const root = doc.querySelector("#single-content");
    if (!match || !root) return null;
    const title = squash(doc.querySelector(".article-header h1")?.textContent) || meta(doc, "og:title") ||
      squash(doc.title).replace(/\s*\|\s*ArchDaily 中文版\s*$/, "");
    const stamp = meta(doc, "article:published_time") || meta(doc, "cXenseParse:publishtime");
    const parsed = Date.parse(stamp || "");
    const { body, images } = globalThis.__XHX_DOM.walk(root, {
      base: loc.href,
      skip(node) {
        return node.matches?.(".thumbs, .article-meta, .afd-specs__btn, #content-placeholder, .loader, .gallery-link__overlay, .gallery-thumbs");
      },
      imageUrl: (img) => imageUrl(img, loc),
    });
    if (!title || (!body && !images.length)) return null;
    const keywords = meta(doc, "keywords");
    const galleryCount = doc.querySelectorAll(".gallery-thumbs-img").length;
    return {
      id: match[1],
      title,
      nick: title.includes(" / ") ? title.split(" / ").slice(-1)[0] : "ArchDaily",
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body,
      images,
      galleryCount,
      galleryPending: galleryCount === 0,
      videos: [],
      audioPending: !!doc.querySelector(".audio-player[data-audio-preview-url]"),
      comments: [],
      tags: keywords ? keywords.split(",").map((tag) => squash(tag)).filter(Boolean) : [],
      url: loc.origin + loc.pathname,
      warnings: [],
    };
  }

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { credentials: "include", signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async function expand(initial) {
    let bodyError = "";
    try {
      const lang = location.pathname.split("/")[1];
      const api = `${location.origin}/${lang}/${initial.id}/gated-content.json?src=projects-unregistered`;
      const response = await fetchWithTimeout(api, 15000);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      if (typeof payload.content !== "string" || !payload.content.trim()) throw new Error("正文接口为空");
      const root = document.createElement("div");
      root.innerHTML = payload.content;
      const more = globalThis.__XHX_DOM.walk(root, {
        base: location.href,
        offset: initial.images.length,
        imageUrl: (img) => imageUrl(img, location),
      });
      initial.body += (initial.body && more.body ? "\n\n" : "") + more.body;
      initial.images.push(...more.images);
    } catch (error) {
      bodyError = String(error?.message || error);
    }

    try {
      /* 正文接口与静态图库互不依赖：正文失败也不能把图库一起跳过。 */
      const pageResponse = await fetchWithTimeout(location.href, 15000);
      if (!pageResponse.ok) throw new Error("HTTP " + pageResponse.status);
      const pageDoc = new DOMParser().parseFromString(await pageResponse.text(), "text/html");
      const existing = new Set(initial.images);
      const gallery = [];
      for (const img of [...pageDoc.querySelectorAll(".gallery-thumbs-img"), ...document.querySelectorAll(".gallery-thumbs-img")]) {
        const url = imageUrl(img, location);
        if (url && !existing.has(url)) {
          existing.add(url);
          gallery.push(url);
        }
      }
      if (gallery.length) {
        initial.galleryStart = initial.images.length;
        initial.body += "\n\n## 项目图库\n\n";
        for (const url of gallery) {
          initial.images.push(url);
          initial.body += `\u0000${initial.images.length - 1}\u0000\n\n`;
        }
      }

      /* 只保存公开音频预览，不请求需要授权的完整音频。 */
      const audioPlayer = [document, pageDoc].map((doc) => doc.querySelector(".audio-player[data-audio-preview-url]")).find(Boolean);
      if (audioPlayer) {
        const preview = new URL(audioPlayer.getAttribute("data-audio-preview-url"), location.origin).href;
        if (!initial.videos.some((item) => item.url === preview)) {
          const index = initial.videos.length;
          initial.videos.push({ url: preview, kind: "audio", label: "音频预览", ext: ".mp3" });
          initial.body += `\n\n## 音频预览\n\n\u0001${index}\u0001\n\n`;
          initial.warnings.push("仅保存网站公开的音频预览；完整音频需页面授权。");
        }
      }

      /* 项目视频可能是 YouTube 等第三方嵌入；保留原链接，不冒充本地视频文件。 */
      const externalVideos = new Set();
      for (const doc of [document, pageDoc]) {
        for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(script.textContent);
            for (const node of Array.isArray(data) ? data : [data]) {
              const embed = node?.video?.embedUrl;
              if (embed && /^https?:\/\//i.test(embed)) externalVideos.add(embed);
            }
          } catch (error) {}
        }
      }
      for (const url of externalVideos) {
        initial.body += `\n\n## 外部视频\n\n[打开第三方视频](${url})\n\n> 第三方嵌入，未下载视频文件。\n`;
      }
    } catch (error) {
      initial.warnings.push(`项目图库读取失败（${String(error?.message || error)}）。`);
    }
    if (bodyError) initial.warnings.push(`正文扩展读取失败（${bodyError}），已保存当前正文与可用的项目图库。`);
    return initial;
  }

  globalThis.__XHX_CLIP.mount({ key: "archdaily", source: "ArchDaily", match: MATCH, read, expand, comments: false });
})();
