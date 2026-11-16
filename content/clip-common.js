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
    /* 取消：9 个共用 clip-common 的站点以前都没有出口，点了「剪藏」只能等它跑完。
     * 现在每次 run() 生成一个 taskId，逐批下发给 background 的 downloadFiles，
     * 用户在面板上点「取消」时两件事同时发生——这里置位 shouldStop，那边
     * background 收到 cancel 消息后 downloadList 每轮都会问一次。
     * 两处都要，缺一个会出现「界面说取消了、文件还在往下落」。 */
    const taskId = options.taskId || "";
    const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
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
    let cancelled = false;

    if (withMedia) {
      try {
        let done = 0;
        for (let i = 0; i < images.length; i += BATCH) {
          /* 每批开头问一次：已经点过取消就别再取图、别再写盘。 */
          if (shouldStop()) { cancelled = true; break; }
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
          const wrote = await chrome.runtime.sendMessage({ type: "downloadFiles", data: { files: batch, taskId } });
          /* 后台说它按取消收尾了，就不必再往下走。
           * 这一批也不能算成功：downloadList 只回一个 done 计数，不告诉我们是
           * 哪几个文件落成了盘，没法把 done 对回文件名。宁可误判成「没保存」
           * 让正文少一条引用（用户看得见，也知道去补），也不能猜出一道悬空链接。 */
          if (wrote?.cancelled) { cancelled = true; }
          const bad = new Set();
          if (wrote?.cancelled) {
            for (const j of batchIdx) bad.add(j);
          } else if (wrote?.error) {
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
          if (cancelled) break;
        }
      } catch (error) {
        mediaError = String(error?.message || error);
      }
    }

    if (withVideos && !cancelled) {
      for (let i = 0; i < videos.length; i += BATCH) {
        if (shouldStop()) { cancelled = true; break; }
        const batch = [];
        const batchIdx = [];
        for (let j = i; j < Math.min(i + BATCH, videos.length); j++) {
          batch.push({ filename: layout.prefix + videoNames[j], url: videos[j].url });
          batchIdx.push(j);
        }
        const wrote = await chrome.runtime.sendMessage({ type: "downloadFiles", data: { files: batch, taskId } });
        if (wrote?.cancelled) cancelled = true;
        const bad = new Set();
        /* 与图片同理：取消的这批不回文件名，只能整体判失败 */
        if (wrote?.cancelled) {
          for (const j of batchIdx) bad.add(j);
        } else if (wrote?.error) {
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
        if (cancelled) break;
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
    if (cancelled) {
      /* 取消后仍要把已经落盘的部分写成笔记，否则用户点了取消、盘上却是一堆
       * 没有索引的散图。正文里明确说这是半成品，并交代怎么补全。 */
      body += `\n\n> 已取消：媒体只保存到第 ${written.size + videoWritten.size} 项，正文尚未抓全。`;
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
    /* 注销 background 侧的任务条目。放在这里而不是每批之后：一个任务对应整个
     * deliver，提前注销会让落在批间的取消信号落空（见 background.js 的 taskEnd）。
     * 页面被直接关掉时这条发不出去，那条记录会留到 SW 回收，几字节而已。 */
    if (taskId) {
      try {
        chrome.runtime.sendMessage({ type: "taskEnd", data: { taskId } }).catch(() => {});
      } catch (error) {}
    }
    return {
      media: written.size + videoWritten.size,
      total: images.length + videos.length,
      commentCount: (info.comments || []).reduce((sum, item) => sum + 1 + (item.replies?.length || 0), 0),
      commentsFailed: !!info.commentError || warnings.length > 0,
      mdSaved: !(mdRes?.error || mdRes?.failed?.some((file) => file?.filename === layout.md)),
      dir: layout.prefix.replace(/\/$/, ""),
      failedWrite,
      mediaError,
      cancelled,
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
    /* 当前正在跑的任务 id；空串表示空闲。run() 里生成、finally 里清掉，
     * 按钮靠它决定此刻是「剪藏」还是「取消」。
     * stopRequested 必须和它同作用域：requestCancel 是按钮事件，run 是另一个
     * 调用栈，放在 run 里取消动作就够不着了。 */
    let runTaskId = "";
    let stopRequested = false;

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
      /* 每次运行一个任务 id：content 侧用它判断「该不该继续下一批」，
       * background 侧用它挂取消标志（downloadFiles 会带上它）。
       * 用时间戳而不是自增计数器：脚本可能被站点重渲染重复注入，模块级计数器
       * 在两个实例里会撞号，时间戳加随机后缀基本不会。 */
      const taskId = `${config.key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      stopRequested = false;
      runTaskId = taskId;
      const mediaTotal = (prefs.media ? info.images?.length || 0 : 0) + (prefs.video ? info.videos?.length || 0 : 0);
      status.textContent = mediaTotal ? `正在整理 0/${mediaTotal} 项媒体…` : "正在整理正文…";
      try {
        const result = await deliver(config, info, (done, total) => {
          status.textContent = `正在整理 ${done}/${total} 项媒体…`;
        }, {
          withMedia: prefs.media,
          withVideos: prefs.video,
          withComments,
          taskId,
          shouldStop: () => stopRequested,
        });
        if (result.cancelled) {
          status.textContent = `已取消，已保存 ${result.media}/${result.total} 项媒体（正文不完整）`;
        } else if (!result.mdSaved) status.textContent = "Markdown 未保存，请重试";
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
        runTaskId = "";
        button.dataset.busy = "";
        button.classList.remove("is-busy");
        renderCancel();
        setTimeout(() => { status.textContent = ""; }, 8000);
      }
    }

    /* 运行中把「剪藏」就地变成「取消」：不给额外按钮，免得界面上多一行；
     * 鼠标移上去就能点，取消后按钮自己恢复。 */
    function renderCancel() {
      if (!button) return;
      const busy = !!runTaskId;
      button.classList.toggle("is-running", busy);
      const label = button.querySelector("span");
      if (label) label.textContent = busy ? "取消" : "剪藏";
      button.title = busy ? "正在保存，点此取消" : `保存这篇${config.source}内容`;
    }

    function requestCancel(event) {
      if (!runTaskId) return;
      event.preventDefault();
      event.stopPropagation();
      const id = runTaskId;
      /* 两边都要通知：本地置位（下一批不再取图），后台登记取消（downloadList
       * 每轮会问）。只通知一边的话，会出现「界面说取消了、文件还在落」或
       * 「本批停了、后台还在核」的错位。 */
      stopRequested = true;
      try {
        chrome.runtime.sendMessage({ type: "cancel", downloadId: id }).catch(() => {});
      } catch (error) {}
      if (status) status.textContent = "正在取消…";
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
      /* 一个按钮两种身份：空闲时是「剪藏」，跑起来后就地变成「取消」。
       * 不给第二个按钮——站点上本来就挤，多一个按钮比多一段提示更碍事。 */
      button.addEventListener("click", (event) => {
        if (runTaskId) requestCancel(event);
        else run(event);
      });
      for (const action of panel.querySelectorAll(".xhx-dz-go")) action.addEventListener("click", run);

      dock.append(button, panel, status);
      document.documentElement.append(dock);
      loadPrefs();
      renderSeg();
      renderHint();
      renderCancel();
      const place = () => {
        const anchor = document.querySelector("h1, h3, article");
        const top = anchor ? anchor.getBoundingClientRect().top + 8 : 112;
        dock.style.top = Math.max(12, Math.min(Math.round(top), window.innerHeight - 80)) + "px";
      };
      place();
      window.addEventListener("resize", place);
      RN.tickLoop(() => {
        dock.hidden = !config.match.test(location.pathname);
        if (!dock.hidden) place();
      });
    }

    create();
    /* 页面异步到位或客户端跳转时再尝试一次；已建 dock 不重复创建。
     * 用 tickLoop 而不是裸 setInterval：后台标签页不烧 CPU，卸载时自动停表。 */
    RN.tickLoop(create, 1800);
  }

  globalThis.__XHX_CLIP = { mount };
})();
