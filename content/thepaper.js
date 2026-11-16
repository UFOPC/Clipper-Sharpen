/* 澎湃新闻（thepaper.cn）单篇文章适配
 *
 * 结构要点（2026-11 实测 newsDetail_forward_34440595）：
 *   路由   /newsDetail_forward_<contId>，首页与频道页不注入
 *   元数据 #__NEXT_DATA__.props.pageProps.detailData.contentDetail
 *          name / author / publishTime / tagList，比 article:author 的通用站名更准确
 *   正文   div[class*="cententWrap__"]（站方 class 拼写就是 centent）
 *   图片   <img data-src="https://imgpai.thepaper.cn/…?x-oss-process=image/resize,w_1024">
 *          src 常是 1x1 data: 占位图；去掉 x-oss-process 后裸请求返回 200 原图
 *   媒体   content 内的 audio/video src；voiceInfo.voiceSrc 是独立「听全文」MP3
 *   评论   api.thepaper.cn/comment/news/comment/talkList，热评 + 新评按 commentId 去重
 *
 * 只保存当前这一篇，不做首页、频道或历史文章批量抓取。
 * 普通 MP3/MP4 由后台直接下载；先下媒体、后写 md，失败媒体不会在正文里留下死链。
 * HLS（m3u8）、DRM 与 iframe 不做转换或绕过；评论接口失败时回退到页面已加载评论。
 */
(() => {
  const RN = globalThis.__RN;
  if (!RN) return;

  const ARTICLE_RE = /^\/newsDetail_forward_(\d+)/;
  if (!ARTICLE_RE.test(location.pathname)) return;
  if (document.querySelector('.xhx-dz-dock[data-xhx-site="thepaper"]')) return;

  const PREFS_KEY = "thepaper-prefs";
  const prefs = { media: true };
  const MAX_MEDIA = 300;
  const MAX_COMMENTS = 300;
  const MAX_COMMENT_PAGES = 15;
  const COMMENT_API = "https://api.thepaper.cn/comment/news/comment/talkList";
  const BATCH = 8;
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "div", "dl", "dt", "dd",
    "figure", "figcaption", "footer", "header", "ol", "p", "pre", "section",
    "table", "tbody", "thead", "tfoot", "tr", "ul",
  ]);
  const DROP = new Set(["script", "style", "noscript", "svg", "input", "button", "source", "track"]);

  const squash = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  /* ---------------- 页面取数 ---------------- */

  function meta(name) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return el ? squash(el.getAttribute("content")) : "";
  }

  function detailData() {
    const el = document.querySelector("#__NEXT_DATA__");
    if (!el) return {};
    try {
      const data = JSON.parse(el.textContent);
      return data?.props?.pageProps?.detailData?.contentDetail || {};
    } catch (error) {
      return {};
    }
  }

  function bodyRoot() {
    return (
      document.querySelector('div[class*="cententWrap__"]') ||
      document.querySelector(".news_txt, .news_content, .article-content")
    );
  }

  function publishedMs(data) {
    const numeric = Number(data.publishTime);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const raw = data.pubTime || meta("article:published_time");
    const parsed = Date.parse(raw || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function imageUrl(img) {
    const current = img.currentSrc && !img.currentSrc.startsWith("data:") ? img.currentSrc : "";
    const raw =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-backsrc") ||
      current ||
      img.getAttribute("src") ||
      "";
    if (!raw) return "";
    try {
      const url = new URL(raw, location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      /* 只删除已知的缩略图指令，签名或其它查询参数原样保留。 */
      url.searchParams.delete("x-oss-process");
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function normalizeMediaUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      /* 澎湃页内个别音频仍写 http；同一地址的 https 已实测返回 200。 */
      if (url.protocol === "http:" && /(?:^thepaper\.cn$|\.thepaper\.cn$|^thepaperaudiooutput\.oss-cn-shanghai\.aliyuncs\.com$)/i.test(url.hostname)) {
        url.protocol = "https:";
      }
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function mediaElementUrl(el) {
    const source = el.querySelector?.("source");
    return normalizeMediaUrl(
      el.getAttribute("src") || el.currentSrc || source?.getAttribute("src") || source?.src || ""
    );
  }

  function mediaExt(url, kind) {
    const fallback = kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".jpg";
    try {
      const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
      const ext = match ? match[1].toLowerCase().replace("jpeg", "jpg") : "";
      const allowed = kind === "image"
        ? /^(jpe?g|png|gif|webp|avif|bmp|svg)$/
        : kind === "video"
          ? /^(mp4|mov|m4v|webm|ogv)$/
          : /^(mp3|m4a|aac|wav|ogg|oga|flac)$/;
      return ext && allowed.test(ext) ? "." + ext : fallback;
    } catch (error) {
      return fallback;
    }
  }

  /* 图片与音视频共用一套原位占位符；下载结束后按真实落盘结果替换。 */
  function walkBody(root, data) {
    const out = [];
    const media = [];
    const seen = new Set();
    let unsupported = 0;
    let truncated = false;

    const push = (text) => {
      if (text) out.push(text);
    };

    function addMedia(url, kind) {
      if (!url || seen.has(url)) return;
      if (kind !== "image" && /\.m3u8(?:$|[?#])/i.test(url)) {
        unsupported++;
        push("\n\n> HLS（m3u8）媒体暂不支持直接下载。\n\n");
        return;
      }
      if (media.length >= MAX_MEDIA) {
        truncated = true;
        return;
      }
      seen.add(url);
      media.push({ url, kind });
      push("\n\n\u0000" + (media.length - 1) + "\u0000\n\n");
    }

    function visit(node) {
      if (node.nodeType === 3) {
        push(node.nodeValue.replace(/\u00a0/g, " "));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (DROP.has(tag)) return;

      if (tag === "img") {
        addMedia(imageUrl(node), "image");
        return;
      }
      if (tag === "video" || tag === "audio") {
        const url = mediaElementUrl(node);
        if (url) addMedia(url, tag);
        else {
          unsupported++;
          push(`\n\n> ${tag === "video" ? "视频" : "音频"}未取到可下载地址。\n\n`);
        }
        return;
      }
      if (tag === "iframe") {
        unsupported++;
        push("\n\n> iframe 内嵌内容未下载。\n\n");
        return;
      }
      if (tag === "br") {
        push("\n");
        return;
      }
      if (tag === "hr") {
        push("\n\n---\n\n");
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        push("\n\n" + "#".repeat(Number(tag[1])) + " ");
        for (const child of node.childNodes) visit(child);
        push("\n\n");
        return;
      }
      if (tag === "strong" || tag === "b") {
        push("**");
        for (const child of node.childNodes) visit(child);
        push("**");
        return;
      }
      if (tag === "em" || tag === "i") {
        push("*");
        for (const child of node.childNodes) visit(child);
        push("*");
        return;
      }
      if (tag === "code") {
        push("`");
        for (const child of node.childNodes) visit(child);
        push("`");
        return;
      }
      if (tag === "a" && !node.querySelector("img")) {
        const text = squash(node.textContent);
        const raw = node.getAttribute("href") || "";
        try {
          const href = new URL(raw, location.href);
          if (text && /^https?:$/.test(href.protocol)) {
            push(`[${text}](${href.href})`);
            return;
          }
        } catch (error) {
          /* 无有效地址时保留链接文字，继续走普通节点。 */
        }
      }
      if (tag === "li") {
        const ordered = node.parentElement?.tagName.toLowerCase() === "ol";
        const index = ordered ? [...node.parentElement.children].indexOf(node) + 1 : 0;
        push("\n" + (ordered ? `${index}. ` : "- "));
        for (const child of node.childNodes) visit(child);
        push("\n");
        return;
      }
      if (tag === "blockquote") {
        push("\n\n> ");
        for (const child of node.childNodes) visit(child);
        push("\n\n");
        return;
      }

      if (BLOCK.has(tag)) push("\n\n");
      for (const child of node.childNodes) visit(child);
      if (BLOCK.has(tag)) push("\n\n");
    }

    visit(root);

    /* “听全文”不在 content HTML 里，是 contentDetail.voiceInfo 的独立音频。 */
    const voice = normalizeMediaUrl(data.voiceInfo?.voiceSrc);
    if (voice && !seen.has(voice)) {
      push("\n\n## 听全文\n\n");
      addMedia(voice, "audio");
    }

    const text = out
      .join("")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, media, unsupported, truncated };
  }

  function readArticle() {
    const match = ARTICLE_RE.exec(location.pathname);
    if (!match) return null;

    const data = detailData();
    let root = bodyRoot();
    /* 原始 content 同时覆盖文字、图片、音频和纯视频页；DOM 只作旧版式兜底。 */
    if (typeof data.content === "string" && data.content.trim()) {
      root = document.createElement("div");
      root.innerHTML = data.content;
    }
    if (!root) return null;

    const title =
      squash(data.name) ||
      squash(document.querySelector("h1")?.textContent) ||
      meta("og:title") ||
      squash(document.title).replace(/_澎湃新闻-The Paper\s*$/, "");
    const nick = squash(data.author) || meta("article:author") || squash(data.source);
    const parsed = walkBody(root, data);
    if (!title || (!parsed.text && !parsed.media.length)) return null;

    const rawTags = Array.isArray(data.tagList) ? data.tagList : Array.isArray(data.tags) ? data.tags : [];
    const tags = rawTags
      .map((item) => squash(typeof item === "string" ? item : item?.tag || item?.name))
      .filter(Boolean);

    return {
      id: match[1],
      title,
      nick,
      time: publishedMs(data),
      body: parsed.text,
      media: parsed.media,
      unsupported: parsed.unsupported,
      truncated: parsed.truncated,
      tags,
      url: "https://www.thepaper.cn/newsDetail_forward_" + match[1],
    };
  }

  /* ---------------- 评论 ---------------- */

  const commentText = (value) => String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  function commentTime(item) {
    const time = squash(item.originCreateTime || item.createTime);
    const place = squash(item.location || item.userInfo?.location);
    return time + (place ? " · " + place : "");
  }

  function fromApiComment(item) {
    const replies = (Array.isArray(item.commentReply) ? item.commentReply : [])
      .map((reply) => ({
        author: squash(reply.userInfo?.sname || reply.userName) || "匿名",
        time: commentTime(reply),
        text: commentText(reply.content),
      }))
      .filter((reply) => reply.text);
    return {
      id: String(item.commentId || ""),
      author: squash(item.userInfo?.sname || item.userName) || "匿名",
      time: commentTime(item),
      text: commentText(item.content),
      replies,
    };
  }

  function fromDomComment(root, withReplies = true) {
    const inner = root.querySelector(":scope > .ant-comment-inner") || root;
    const text = commentText(inner.querySelector('[class*="contentWrapper"]')?.textContent);
    const author = squash(inner.querySelector(".ant-comment-content-author-name")?.textContent) || "匿名";
    const time = squash(inner.querySelector('[class*="actionsBox"] > :first-child')?.textContent);
    const replies = withReplies
      ? [...root.querySelectorAll('[class*="replyWrapper"] .ant-comment')]
        .map((reply) => fromDomComment(reply, false))
        .filter((reply) => reply.text)
      : [];
    return { id: "", author, time, text, replies };
  }

  function readDomComments() {
    const list = [];
    const seen = new Set();
    for (const root of document.querySelectorAll('.ant-comment[class*="costomComment"]')) {
      const comment = fromDomComment(root);
      if (!comment.text && !comment.replies.length) continue;
      const key = comment.author + "|" + comment.time + "|" + comment.text;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(comment);
      if (list.length >= MAX_COMMENTS) break;
    }
    return list;
  }

  async function fetchComments(contId) {
    const list = [];
    const seen = new Set();
    const errors = [];

    for (const commentSort of [1, 2]) {
      if (list.length >= MAX_COMMENTS) break;
      let pageNum = 1;
      let lastId = null;
      try {
        for (let page = 0; page < MAX_COMMENT_PAGES && list.length < MAX_COMMENTS; page++) {
          const response = await fetch(COMMENT_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ contId, pageSize: 20, commentSort, contType: 1, pageNum, lastId }),
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          const payload = await response.json();
          if (payload.code !== 200) throw new Error(payload.desc || "评论接口返回 " + payload.code);
          const data = payload.data || {};
          const items = Array.isArray(data.list) ? data.list : [];
          const before = seen.size;
          for (const item of items) {
            const comment = fromApiComment(item);
            if (!comment.text && !comment.replies.length) continue;
            const key = comment.id || comment.author + "|" + comment.time + "|" + comment.text;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push(comment);
            if (list.length >= MAX_COMMENTS) break;
          }
          if (!data.hasNext || !items.length || seen.size === before) break;
          lastId = items[items.length - 1]?.commentId ?? null;
          pageNum++;
        }
      } catch (error) {
        errors.push((commentSort === 1 ? "热评论" : "新评论") + "：" + String(error?.message || error));
      }
    }

    /* 接口被拦时不丢用户眼前已有的评论，但必须注明只是页面已加载部分。 */
    if (!list.length) {
      const fallback = readDomComments();
      if (fallback.length) {
        list.push(...fallback);
        if (errors.length) errors.push("已回退到页面已加载评论");
      }
    }
    return { list: list.slice(0, MAX_COMMENTS), errors };
  }

  /* ---------------- 下载与 Markdown ---------------- */

  async function deliver(info, onProgress, options = {}) {
    const withMedia = options.withMedia !== false;
    const withComments = !!options.withComments;
    let comments = [];
    let commentsErrors = [];
    if (withComments) {
      try {
        const result = await fetchComments(info.id);
        comments = result.list;
        commentsErrors = result.errors;
      } catch (error) {
        commentsErrors = [String(error?.message || error)];
      }
    }

    const layout = RN.layout(info.title, info.nick, info.time);
    const total = info.media.length;
    let imageNo = 0;
    let avNo = 0;
    const entries = info.media.map((item) => {
      const isImage = item.kind === "image";
      const no = isImage ? ++imageNo : ++avNo;
      return {
        path: RN.mediaPath(layout.mediaStem, no, mediaExt(item.url, item.kind), !isImage),
        label: isImage ? String(no) : (item.kind === "audio" ? "音频 " : "视频 ") + no,
      };
    });
    const written = new Set();
    const failedWrite = [];
    let mediaError = "";

    if (withMedia) {
      try {
        let done = 0;
        for (let i = 0; i < total; i += BATCH) {
          const batch = [];
          const batchIdx = [];
          for (let j = i; j < Math.min(i + BATCH, total); j++) {
            batch.push({ filename: layout.prefix + entries[j].path, url: info.media[j].url });
            batchIdx.push(j);
          }
          if (batch.length) {
            const wrote = await chrome.runtime.sendMessage({ type: "downloadFiles", data: { files: batch } });
            const bad = new Set();
            if (wrote?.error) {
              for (const j of batchIdx) {
                bad.add(j);
                failedWrite.push({ filename: layout.prefix + entries[j].path, error: wrote.error });
              }
            } else if (wrote?.failed) {
              failedWrite.push(...wrote.failed);
              for (const file of wrote.failed) {
                const hit = batchIdx.find((j) => layout.prefix + entries[j].path === file?.filename);
                if (hit != null) bad.add(hit);
              }
            }
            for (const j of batchIdx) if (!bad.has(j)) written.add(j);
          }
          done += batch.length;
          if (onProgress) onProgress(done, total);
        }
      } catch (error) {
        mediaError = String(error?.message || error);
        console.warn("小红虾 · 澎湃媒体下发中断", error);
      }
    }

    const missing = [];
    let body = info.body.replace(/\u0000(\d+)\u0000/g, (_, value) => {
      const index = Number(value);
      if (!withMedia) return "";
      if (!written.has(index)) {
        missing.push(index + 1);
        return "";
      }
      /* Obsidian 对音频使用 wikilink 嵌入才能稳定显示播放器；图片/视频沿用项目原有 Markdown 语法。 */
      if (info.media[index].kind === "audio") return `![[${entries[index].path}]]`;
      return `![${entries[index].label}](${RN.rel(entries[index].path)})`;
    });

    if (info.truncated) body += `\n\n> 媒体超过上限，仅保留前 ${MAX_MEDIA} 项。`;
    if (missing.length) {
      const why = mediaError || (failedWrite.length ? RN.writeFailNote(failedWrite, 3) : "未知原因");
      body += `\n\n> 有 ${missing.length} 项媒体未能保存（${why}），正文中已略去对应引用。`;
    }
    if (withComments && commentsErrors.length) {
      body += `\n\n> 评论抓取${comments.length ? "可能不完整" : "失败"}（${commentsErrors.join("；")}）。`;
    }
    if (withComments) {
      const commentsText = RN.commentsMarkdown(comments);
      if (commentsText) body += "\n\n" + commentsText;
    }

    const md = RN.markdown({
      source: "澎湃新闻",
      url: info.url,
      title: info.title,
      nick: info.nick,
      timeMs: info.time,
      type: "normal",
      counts: {
        images: info.media.filter((item) => item.kind === "image").length,
        videos: info.media.filter((item) => item.kind === "video").length,
        audios: info.media.filter((item) => item.kind === "audio").length,
      },
      noteId: info.id,
      desc: body,
      tags: info.tags,
      media: [],
    });
    const mdRes = await chrome.runtime.sendMessage({
      type: "downloadFiles",
      data: { files: [{ filename: layout.md, text: md, mime: "text/markdown" }] },
    });
    const mdSaved = !(
      mdRes?.error ||
      (mdRes?.failed && mdRes.failed.some((file) => file?.filename === layout.md))
    );

    return {
      media: written.size,
      total,
      commentCount: comments.reduce((sum, item) => sum + 1 + item.replies.length, 0),
      commentsFailed: commentsErrors.length > 0,
      md: layout.md,
      dir: layout.prefix.replace(/\/$/, ""),
      mdSaved,
      failedWrite,
      mediaError,
    };
  }

  /* ---------------- UI ---------------- */

  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([PREFS_KEY], (data) => {
          const saved = data && data[PREFS_KEY];
          if (saved && typeof saved === "object") prefs.media = saved.media !== false;
          resolve();
        });
      } catch (error) {
        resolve();
      }
    });
  }

  function savePrefs() {
    try {
      chrome.storage.local.set({ [PREFS_KEY]: { ...prefs } });
    } catch (error) {
      /* 偏好存不上不影响本次保存。 */
    }
  }

  function mount() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xhx-dz-btn";
    button.title = "保存这篇澎湃新闻文章";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = `<img src="${chrome.runtime.getURL("icons/icon.svg")}" alt=""><span>剪藏</span>`;

    const panel = document.createElement("div");
    panel.className = "xhx-dz-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "保存本文");
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="xhx-dz-row">',
      '  <div class="xhx-dz-key">媒体<span class="cnt"></span></div>',
      '  <div class="xhx-dz-seg" data-group="media">',
      '    <button type="button" data-value="1">下载</button>',
      '    <button type="button" data-value="0">跳过</button>',
      "  </div>",
      "</div>",
      '<div class="xhx-dz-actions">',
      '  <button type="button" class="xhx-dz-go" data-comments="0">正文</button>',
      '  <button type="button" class="xhx-dz-go is-ghost" data-comments="1">正文+回复</button>',
      "</div>",
    ].join("");

    const status = document.createElement("div");
    status.className = "xhx-dz-status";
    status.setAttribute("role", "status");
    const dock = document.createElement("div");
    dock.className = "xhx-dz-dock";
    dock.dataset.xhxSite = "thepaper";

    const countEl = panel.querySelector(".xhx-dz-key .cnt");
    const seg = panel.querySelector(".xhx-dz-seg");

    const renderSeg = () => {
      for (const option of seg.querySelectorAll("button")) {
        const on = (option.dataset.value === "1") === prefs.media;
        option.classList.toggle("is-on", on);
        option.setAttribute("aria-pressed", on ? "true" : "false");
      }
    };

    const renderHint = () => {
      const info = readArticle();
      const media = info ? info.media : [];
      const images = media.filter((item) => item.kind === "image").length;
      const av = media.length - images;
      const parts = [];
      if (images) parts.push(`${images} 图`);
      if (av) parts.push(`${av} 音视频`);
      countEl.textContent = parts.length ? parts.join(" · ") : "无";
    };

    const openPanel = () => {
      if (!panel.hidden) return;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      renderSeg();
      renderHint();
    };
    const closePanel = () => {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };

    dock.addEventListener("mouseenter", () => {
      if (!button.dataset.busy) openPanel();
    });
    dock.addEventListener("mouseleave", closePanel);
    seg.addEventListener("click", (event) => {
      const option = event.target.closest("button[data-value]");
      if (!option) return;
      prefs.media = option.dataset.value === "1";
      savePrefs();
      renderSeg();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel();
    });
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !dock.contains(event.target)) closePanel();
    });

    const run = async (event) => {
      if (button.dataset.busy) return;
      const withComments = event?.currentTarget?.dataset?.comments === "1";
      const info = readArticle();
      if (!info) {
        status.textContent = "未识别到澎湃文章正文";
        return;
      }
      closePanel();
      button.dataset.busy = "1";
      button.classList.add("is-busy");
      status.textContent = withComments
        ? "正在读取评论…"
        : prefs.media
          ? `正在整理 0/${info.media.length} 项媒体…`
          : "正在整理正文…";
      try {
        const result = await deliver(
          info,
          (done, total) => {
            status.textContent = `正在整理 ${done}/${total} 项媒体…`;
          },
          { withMedia: prefs.media, withComments }
        );
        if (!result.mdSaved) {
          status.textContent = "Markdown 未保存，请重试";
        } else {
          const parts = [];
          if (prefs.media) parts.push(`${result.media}/${result.total} 项媒体`);
          if (withComments) parts.push(`${result.commentCount} 条评论`);
          parts.push(`${info.body.length} 字正文`);
          status.textContent = `已提交 ${parts.join(" + ")} → ${result.dir}` +
            (result.failedWrite.length || result.mediaError || result.commentsFailed
              ? "（部分媒体或评论失败，详见 Markdown）"
              : "");
        }
      } catch (error) {
        status.textContent = "保存失败：" + String(error?.message || error);
      } finally {
        button.dataset.busy = "";
        button.classList.remove("is-busy");
        setTimeout(() => {
          status.textContent = "";
        }, 8000);
      }
    };

    button.addEventListener("click", run);
    for (const action of panel.querySelectorAll(".xhx-dz-go")) action.addEventListener("click", run);

    const placeDock = () => {
      const anchor = document.querySelector("h1");
      let top = 112;
      if (anchor) top = anchor.getBoundingClientRect().top + 8;
      dock.style.top = Math.max(12, Math.min(Math.round(top), window.innerHeight - 80)) + "px";
    };

    dock.append(button, panel, status);
    document.documentElement.append(dock);
    placeDock();
    renderSeg();
    renderHint();
    window.addEventListener("resize", placeDock);

    /* Next.js 详情页之间可走客户端跳转；同一个 dock 复用，点击时重新读当前文章。 */
    setInterval(() => {
      /* 纯视频页没有 cententWrap，但 readArticle() 可直接读 __NEXT_DATA__.content。
       * 这里只看路由；数据尚未就绪时保留按钮，由点击后的读取结果给提示，避免闪烁。 */
      const valid = ARTICLE_RE.test(location.pathname);
      dock.hidden = !valid;
      if (valid) placeDock();
    }, 1500);
  }

  loadPrefs().then(mount);
})();
