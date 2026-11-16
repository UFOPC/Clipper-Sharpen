/* 单篇图文/论坛剪藏共用引擎。站点适配器提供 read()，可选 expand() 负责分页。 */
(() => {
  const RN = globalThis.__RN;
  if (!RN) return;
  const BATCH = 8;

  const extOf = (url) => {
    try {
      const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
      const ext = match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
      return /^(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(ext) ? "." + ext : ".jpg";
    } catch (error) {
      return ".jpg";
    }
  };

  const videoExt = (url) => {
    try {
      const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
      const ext = match ? match[1].toLowerCase() : "mp4";
      return /^(mp4|mov|m4v|webm|ogv|mp3|wav|m4a|aac|ogg|oga)$/.test(ext) ? "." + ext : ".mp4";
    } catch (error) { return ".mp4"; }
  };

  async function asDataUrl(config, url) {
    if (!config.fetchMedia) return url;
    const response = await chrome.runtime.sendMessage({ type: "fetchMedia", data: { url } });
    if (!response?.ok) throw new Error(response?.error || "fetchMedia failed");
    return `data:${response.type || "image/jpeg"};base64,${response.base64}`;
  }

  async function deliver(config, initial, onProgress, options) {
    const withMedia = options.withMedia;
    const withVideos = options.withVideos !== false;
    const withComments = options.withComments;
    let info = initial;
    const warnings = [...(initial.warnings || [])];
    if (config.expand) {
      try {
        info = await config.expand(initial, { withComments, onProgress });
      } catch (error) {
        warnings.push("分页扩展中断：" + String(error?.message || error));
      }
    }

    for (const warning of info.warnings || []) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const layout = RN.layout(info.title, info.nick, info.time);
    const images = info.images || [];
    const videos = (info.videos || []).map((item) => typeof item === "string" ? { url: item, kind: "video" } : item);
    const names = images.map((url, index) => {
      const file = RN.mediaPath(layout.mediaStem, index + 1, extOf(url));
      return info.galleryStart != null && index >= info.galleryStart ? file.replace(/^images\//, "gallery/") : file;
    });
    const videoNames = videos.map((item, index) => RN.mediaPath(layout.mediaStem, index + 1, item.ext || videoExt(item.url), true));
    const written = new Set();
    const videoWritten = new Set();
    const failedWrite = [];
    let mediaError = "";

    if (withMedia) {
      try {
        let done = 0;
        for (let i = 0; i < images.length; i += BATCH) {
          const batch = [];
          const batchIdx = [];
          for (let j = i; j < Math.min(i + BATCH, images.length); j++) {
            try {
              const url = await asDataUrl(config, images[j]);
              batch.push({ filename: layout.prefix + names[j], url });
              batchIdx.push(j);
            } catch (error) {
              failedWrite.push({ filename: layout.prefix + names[j], error: String(error?.message || error) });
            }
          }
          const wrote = await chrome.runtime.sendMessage({ type: "downloadFiles", data: { files: batch } });
          const bad = new Set();
          if (wrote?.error) {
            for (const j of batchIdx) {
              bad.add(j);
              failedWrite.push({ filename: layout.prefix + names[j], error: wrote.error });
            }
          } else if (wrote?.failed) {
            failedWrite.push(...wrote.failed);
            for (const file of wrote.failed) {
              const hit = batchIdx.find((j) => layout.prefix + names[j] === file?.filename);
              if (hit != null) bad.add(hit);
            }
          }
          for (const j of batchIdx) if (!bad.has(j)) written.add(j);
          done += batch.length;
          if (onProgress) onProgress(done, images.length);
        }
      } catch (error) {
        mediaError = String(error?.message || error);
      }
    }

    if (withVideos) {
      for (let i = 0; i < videos.length; i += BATCH) {
        const batch = [];
        const batchIdx = [];
        for (let j = i; j < Math.min(i + BATCH, videos.length); j++) {
          batch.push({ filename: layout.prefix + videoNames[j], url: videos[j].url });
          batchIdx.push(j);
        }
        const wrote = await chrome.runtime.sendMessage({ type: "downloadFiles", data: { files: batch } });
        const bad = new Set();
        if (wrote?.error) {
          for (const j of batchIdx) {
            bad.add(j);
            failedWrite.push({ filename: layout.prefix + videoNames[j], error: wrote.error });
          }
        } else if (wrote?.failed) {
          failedWrite.push(...wrote.failed);
          for (const file of wrote.failed) {
            const hit = batchIdx.find((j) => layout.prefix + videoNames[j] === file?.filename);
            if (hit != null) bad.add(hit);
          }
        }
        for (const j of batchIdx) if (!bad.has(j)) videoWritten.add(j);
        if (onProgress) onProgress(images.length + Math.min(i + BATCH, videos.length), images.length + videos.length);
      }
    }

    const missing = [];
    const missingVideos = [];
    let body = String(info.body || "").replace(/\u0000(\d+)\u0000/g, (_, value) => {
      const index = Number(value);
      if (!withMedia) return "";
      if (!written.has(index)) {
        missing.push(index + 1);
        return "";
      }
      return `![${index + 1}](${RN.rel(names[index])})`;
    });
    body = body.replace(/\u0001(\d+)\u0001/g, (_, value) => {
      const index = Number(value);
      if (!withVideos) return "";
      if (!videoWritten.has(index)) {
        missingVideos.push(index + 1);
        return "";
      }
      const item = videos[index];
      const label = item?.label || (item?.kind === "audio" ? `音频 ${index + 1}` : `视频 ${index + 1}`);
      return `![${label}](${RN.rel(videoNames[index])})`;
    });
    if (!withVideos) body = body.replace(/\n*## (?:视频|音频预览)\n\n/g, "\n\n");
    for (const warning of warnings) body += `\n\n> ${warning}`;
    if (missing.length) {
      const why = mediaError || (failedWrite.length ? RN.writeFailNote(failedWrite, 3) : "未知原因");
      body += `\n\n> 有 ${missing.length} 张图片未能保存（${why}），正文中已略去对应引用。`;
    }
    if (missingVideos.length) {
      const why = mediaError || (failedWrite.length ? RN.writeFailNote(failedWrite, 3) : "未知原因");
      body += `\n\n> 有 ${missingVideos.length} 个音视频未能保存（${why}），正文中已略去对应引用。`;
    }
    if (withComments && info.commentError) {
      body += `\n\n> 评论抓取可能不完整（${info.commentError}）。`;
    }
    if (withComments) {
      const comments = RN.commentsMarkdown(info.comments || []);
      if (comments) body += "\n\n" + comments;
    }

    const md = RN.markdown({
      source: config.source,
      url: info.url,
      title: info.title,
      nick: info.nick,
      timeMs: info.time,
      type: "normal",
      counts: { images: images.length, videos: videos.length },
      noteId: info.id,
      desc: body,
      tags: info.tags || [],
      media: [],
    });
    const mdRes = await chrome.runtime.sendMessage({
      type: "downloadFiles",
      data: { files: [{ filename: layout.md, text: md, mime: "text/markdown" }] },
    });
    return {
      media: written.size + videoWritten.size,
      total: images.length + videos.length,
      commentCount: (info.comments || []).reduce((sum, item) => sum + 1 + (item.replies?.length || 0), 0),
      commentsFailed: !!info.commentError || warnings.length > 0,
      mdSaved: !(mdRes?.error || mdRes?.failed?.some((file) => file?.filename === layout.md)),
      dir: layout.prefix.replace(/\/$/, ""),
      failedWrite,
      mediaError,
    };
  }

  function mount(config) {
    const prefs = { media: true, video: true };
    const key = "xhx-clip-" + config.key;
    let dock = null;
    let button = null;
    let panel = null;
    let status = null;
    let countEl = null;
    let videoRow = null;
    let videoCountEl = null;

    function loadPrefs() {
      try {
        chrome.storage.local.get([key], (data) => {
          if (data?.[key] && typeof data[key] === "object") {
            prefs.media = data[key].media !== false;
            prefs.video = data[key].video !== false;
          }
        });
      } catch (error) {}
    }

    function renderSeg() {
      for (const option of panel.querySelectorAll(".xhx-dz-seg button")) {
        const value = option.closest("[data-video-row]") ? prefs.video : prefs.media;
        const on = (option.dataset.value === "1") === value;
        option.classList.toggle("is-on", on);
        option.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }

    function renderHint() {
      const info = config.read(document, location);
      const count = info?.images?.length || 0;
      const videos = info?.videos?.length || 0;
      const expectedVideos = (info?.videoIds?.length || info?.videos?.length || 0) + (info?.audioPending ? 1 : 0);
      const galleryCount = info?.galleryCount || 0;
      const galleryPending = !!info?.galleryPending;
      const lines = [];
      if (galleryCount || galleryPending) {
        if (count) lines.push(`正文 ${count}张`);
        lines.push(galleryCount ? `图库 ${galleryCount}张` : "图库 保存时读取");
      } else if (count) {
        lines.push(`${count} 张图`);
      }
      if (!lines.length) lines.push("无");
      countEl.replaceChildren(...lines.map((text) => {
        const line = document.createElement("span");
        line.className = "xhx-dz-count-line";
        const match = /^(正文|图库|音视频)\s+(.+)$/.exec(text);
        if (match) {
          const label = document.createElement("span");
          label.textContent = match[1];
          const value = document.createElement("span");
          const numeric = /^(\d+)(张|个)$/.exec(match[2]);
          if (numeric) {
            const number = document.createElement("span");
            number.className = "xhx-dz-count-number";
            number.textContent = numeric[1];
            const unit = document.createElement("span");
            unit.textContent = numeric[2];
            value.append(number, unit);
          } else value.textContent = match[2];
          line.append(label, value);
        } else line.textContent = text;
        return line;
      }));
      if (videoRow) {
        videoRow.hidden = !expectedVideos;
        videoRow.style.display = expectedVideos ? "" : "none";
        videoCountEl.textContent = expectedVideos ? `${expectedVideos} 个` : "无";
      }
    }

    function closePanel() {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    async function run(event) {
      if (button.dataset.busy) return;
      const withComments = event?.currentTarget?.dataset?.comments === "1";
      const info = config.read(document, location);
      if (!info) {
        status.textContent = "未识别到正文";
        return;
      }
      closePanel();
      button.dataset.busy = "1";
      button.classList.add("is-busy");
      const mediaTotal = (prefs.media ? info.images?.length || 0 : 0) + (prefs.video ? info.videos?.length || 0 : 0);
      status.textContent = mediaTotal ? `正在整理 0/${mediaTotal} 项媒体…` : "正在整理正文…";
      try {
        const result = await deliver(config, info, (done, total) => {
          status.textContent = `正在整理 ${done}/${total} 项媒体…`;
        }, { withMedia: prefs.media, withVideos: prefs.video, withComments });
        if (!result.mdSaved) status.textContent = "Markdown 未保存，请重试";
        else {
          const parts = [];
          if (prefs.media || prefs.video) parts.push(`${result.media}/${result.total} 项媒体`);
          if (withComments) parts.push(`${result.commentCount} 条评论`);
          parts.push(`${info.body.length} 字正文`);
          status.textContent = `已提交 ${parts.join(" + ")} → ${result.dir}` +
            (result.failedWrite.length || result.mediaError || result.commentsFailed ? "（部分内容不完整，详见 Markdown）" : "");
        }
      } catch (error) {
        status.textContent = "保存失败：" + String(error?.message || error);
      } finally {
        button.dataset.busy = "";
        button.classList.remove("is-busy");
        setTimeout(() => { status.textContent = ""; }, 8000);
      }
    }

    function create() {
      if (dock) return;
      const initialInfo = config.read(document, location);
      if (!initialInfo) return;
      button = document.createElement("button");
      button.type = "button";
      button.className = "xhx-dz-btn";
      button.title = `保存这篇${config.source}内容`;
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.innerHTML = `<img src="${chrome.runtime.getURL("icons/icon.svg")}" alt=""><span>剪藏</span>`;

      panel = document.createElement("div");
      panel.className = "xhx-dz-panel";
      panel.setAttribute("role", "dialog");
      panel.hidden = true;
      panel.innerHTML = [
        '<div class="xhx-dz-row">',
        '  <div class="xhx-dz-key"><span class="xhx-dz-label">图片：</span><span class="cnt"></span></div>',
        '  <div class="xhx-dz-seg">',
        '    <button type="button" data-value="1">下载</button>',
        '    <button type="button" data-value="0">跳过</button>',
        "  </div>",
        "</div>",
        '<div class="xhx-dz-row" data-video-row hidden style="display:none">',
        '  <div class="xhx-dz-key">音视频：<span class="cnt"></span></div>',
        '  <div class="xhx-dz-seg" data-video-seg>',
        '    <button type="button" data-value="1">下载</button>',
        '    <button type="button" data-value="0">跳过</button>',
        "  </div>",
        "</div>",
        '<div class="xhx-dz-actions">',
        '  <button type="button" class="xhx-dz-go" data-comments="0">正文</button>',
        config.comments === false || initialInfo.hasComments === false ? "" : '  <button type="button" class="xhx-dz-go is-ghost" data-comments="1">正文+回复</button>',
        "</div>",
      ].join("");
      status = document.createElement("div");
      status.className = "xhx-dz-status";
      status.setAttribute("role", "status");
      dock = document.createElement("div");
      dock.className = "xhx-dz-dock";
      dock.dataset.xhxSite = config.key;
      countEl = panel.querySelector(".xhx-dz-key .cnt");
      videoRow = panel.querySelector("[data-video-row]");
      videoCountEl = videoRow.querySelector(".cnt");

      dock.addEventListener("mouseenter", () => {
        if (button.dataset.busy) return;
        panel.hidden = false;
        button.setAttribute("aria-expanded", "true");
        renderSeg();
        renderHint();
      });
      dock.addEventListener("mouseleave", closePanel);
      for (const seg of panel.querySelectorAll(".xhx-dz-seg")) seg.addEventListener("click", (event) => {
        const option = event.target.closest("button[data-value]");
        if (!option) return;
        const isVideo = !!seg.closest("[data-video-row]");
        if (isVideo) prefs.video = option.dataset.value === "1";
        else prefs.media = option.dataset.value === "1";
        try { chrome.storage.local.set({ [key]: { media: prefs.media, video: prefs.video } }); } catch (error) {}
        renderSeg();
      });
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePanel(); });
      document.addEventListener("click", (event) => {
        if (!panel.hidden && !dock.contains(event.target)) closePanel();
      });
      button.addEventListener("click", run);
      for (const action of panel.querySelectorAll(".xhx-dz-go")) action.addEventListener("click", run);

      dock.append(button, panel, status);
      document.documentElement.append(dock);
      loadPrefs();
      renderSeg();
      renderHint();
      const place = () => {
        const anchor = document.querySelector("h1, h3, article");
        const top = anchor ? anchor.getBoundingClientRect().top + 8 : 112;
        dock.style.top = Math.max(12, Math.min(Math.round(top), window.innerHeight - 80)) + "px";
      };
      place();
      window.addEventListener("resize", place);
      setInterval(() => {
        dock.hidden = !config.match.test(location.pathname);
        if (!dock.hidden) place();
      }, 1500);
    }

    create();
    /* 页面异步到位或客户端跳转时再尝试一次；已建 dock 不重复创建。 */
    setInterval(create, 1800);
  }

  globalThis.__XHX_CLIP = { mount };
})();
