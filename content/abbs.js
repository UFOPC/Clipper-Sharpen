/* ABBS Jute Forum 公开帖：tr.odd 为楼层，span.javascript 为正文。 */
(() => {
  const MATCH = /^\/(?:bbs\/post\/view|news\/read\.php|topic\/read\.php)$/;
  const MAX_PAGES = 20;
  const squash = globalThis.__XHX_DOM.squash;
  const clean = (value) => String(value || "").replace(/\r/g, "").replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function abs(raw, base) {
    try {
      const url = new URL(raw || "", base);
      if (!/^https?:$/.test(url.protocol)) return "";
      if (url.protocol === "http:" && /(?:^|\.)abbs(?:\.com)?\.cn$/i.test(url.hostname)) url.protocol = "https:";
      return url.href;
    } catch (error) { return ""; }
  }

  function parsePage(doc, loc, offset = 0) {
    if (!MATCH.test(loc.pathname)) return null;
    const pageUrl = new URL(loc.href);
    const id = pageUrl.searchParams.get("id");
    const floors = [...doc.querySelectorAll("tr.odd")].filter((row) => row.querySelector("span.javascript"));
    if (!id || !floors.length) return null;
    const cellsOf = (row) => row.querySelectorAll(":scope > td");
    /* 楼主判定：优先用 uid，拿不到才退回「只认第一楼」。
     * 曾经拿昵称判（author === nick），但 ABBS 允许重名，同名网友的回帖会被
     * 并进正文；匿名回帖更惨——大家都叫「匿名」，全都被当成楼主的话。 */
    const uidOf = (row) => {
      const link = row.querySelector('a[href*="user.php"], a[href*="uid="]');
      const m = /[?&](?:id|uid)=(\d+)/.exec((link && link.getAttribute("href")) || "");
      return m ? m[1] : "";
    };
    const opUid = uidOf(floors[0]);
    const firstCells = cellsOf(floors[0]);
    const nick = squash(firstCells[0]?.querySelector("b")?.textContent) || "匿名";
    const firstStamp = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/.exec(firstCells[1]?.textContent || "")?.[0] || "";
    const parsed = Date.parse(firstStamp || "");
    const images = [];
    const bodies = [];
    const comments = [];
    const warnings = [];
    if (!opUid) {
      warnings.push("未能识别楼主 uid，只把第一楼当正文，同作者的其他楼层按回帖处理。");
    }

    floors.forEach((row, index) => {
      const cells = cellsOf(row);
      const author = squash(cells[0]?.querySelector("b")?.textContent) || "匿名";
      const stamp = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/.exec(cells[1]?.textContent || "")?.[0] || "";
      const root = row.querySelector("span.javascript");
      const isOp = opUid ? uidOf(row) === opUid : index === 0;
      if (isOp) {
        const part = globalThis.__XHX_DOM.walk(root, {
          base: loc.href,
          offset: offset + images.length,
          imageUrl(img) {
            const raw = img.getAttribute("data-original") || img.getAttribute("data-src") || img.getAttribute("src") || "";
            const url = abs(raw, loc.href);
            return /\/images\/|pixel\.gif|icon_|star\d|LOGO/i.test(url) ? "" : url;
          },
        });
        if (part.body) bodies.push(part.body);
        images.push(...part.images);
      } else {
        const text = clean(root.textContent);
        if (text) comments.push({ author, time: stamp, text, replies: [] });
      }
    });

    const page = Number(pageUrl.searchParams.get("ppg")) || 1;
    const nextLink = [...doc.querySelectorAll("a")].find((a) => {
      const url = a.getAttribute("href") || "";
      return new RegExp("[?&]ppg=" + (page + 1) + "(?:[&#]|$)").test(url) && /^\d+$/.test(a.textContent.trim());
    });
    const canonical = pageUrl;
    canonical.hash = "";
    canonical.searchParams.delete("ppg");
    return {
      id,
      kind: "forum",
      hasComments: true,
      title: squash(doc.title).replace(/\s*-\s*ABBS 论坛\s*$/, ""),
      nick,
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body: bodies.join("\n\n").trim(),
      images,
      comments,
      next: nextLink ? abs(nextLink.getAttribute("href"), loc.href) : "",
      page,
      url: canonical.href,
      warnings,
    };
  }

  function readArticle(doc, loc) {
    const titleNode = doc.querySelector("td.s center b");
    const root = titleNode?.closest("td.s");
    const id = new URL(loc.href).searchParams.get("recid");
    if (!root || !id) return null;
    const title = squash(titleNode.textContent);
    const stamp = /\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/.exec(doc.body.textContent || "")?.[0] || "";
    const parsed = Date.parse(stamp || "");
    const { body, images } = globalThis.__XHX_DOM.walk(root, {
      base: loc.href,
      skip(node) { return node === titleNode.closest("center"); },
      imageUrl(img) {
        const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
        return abs(raw, loc.href);
      },
    });
    if (!title || (!body && !images.length)) return null;
    return {
      id,
      kind: "article",
      hasComments: false,
      title,
      nick: "ABBS",
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      body,
      images,
      comments: [],
      url: loc.origin + loc.pathname + loc.search,
      warnings: [],
    };
  }

  async function fetchPage(url, offset) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const info = parsePage(doc, new URL(url), offset);
    if (!info) throw new Error("未识别到帖子楼层");
    return info;
  }

  async function expand(initial) {
    if (initial.kind !== "forum") return initial;
    let info = initial;
    if (initial.page !== 1) {
      const first = new URL(initial.url);
      first.searchParams.set("ppg", "1");
      info = await fetchPage(first.href, 0);
    }
    let next = info.next;
    for (let page = info.page + 1; page <= MAX_PAGES && next; page++) {
      try {
        const more = await fetchPage(next, info.images.length);
        info.body += (info.body && more.body ? "\n\n" : "") + more.body;
        info.images.push(...more.images);
        info.comments.push(...more.comments);
        info.next = more.next;
        info.page = more.page;
        next = more.next;
      } catch (error) {
        info.warnings.push(`第 ${page} 页抓取失败（${String(error?.message || error)}），已保留前面页面。`);
        break;
      }
    }
    if (next) info.warnings.push(`仅读取前 ${MAX_PAGES} 页，后续页面未保存。`);
    delete info.next;
    return info;
  }

  globalThis.__XHX_CLIP.mount({
    key: "abbs",
    source: "ABBS建筑论坛",
    match: MATCH,
    read: (doc, loc) => loc.pathname === "/bbs/post/view" ? parsePage(doc, loc) : readArticle(doc, loc),
    expand,
  });
})();
