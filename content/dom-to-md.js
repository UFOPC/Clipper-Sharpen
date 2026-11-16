/* 通用 DOM → Markdown。这是全仓唯一的正文序列化实现。
 *
 * 为什么要一份而不是六份：0.7.8 里 douban / sspai / smzdm / thepaper / wechat
 * 各自抄了一套几乎相同的 walk，改一处规则要改六遍，而且已经抄出可见分叉
 * （澎湃的音频写成 ![[...]]、其余写 ![..](./..)）。正文转 md 的规则是产品行为，
 * 不该按站点各写一份；站点之间真正不同的只有「哪些节点要跳过」「占位符长什么样」
 * 「用哪套空白归一」，这些都用 options 表达。
 *
 * 两套出口：
 *   walk(root, options)      老接口，body + images（缩略图式：只有图片）
 *   walkWith(root, options)  全功能，站点按需传 block/drop/onMedia 等
 *
 * 逐字符行为由 test/dump-md.mjs 的 golden 基准守着——改这里的任何规则，
 * 基准变了就是行为变了，必须说明为什么。
 */
(() => {
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "div", "dl", "dt", "dd", "figure",
    "figcaption", "footer", "header", "ol", "p", "pre", "section", "table", "tbody",
    "thead", "tfoot", "tr", "ul",
  ]);
  const DROP = new Set(["script", "style", "noscript", "svg", "input", "button", "iframe", "video", "audio", "source", "track"]);
  /* 豆瓣/派早/值得买的老规则：这些站点的正文是「一行一段」的富文本，
   * 段落间距靠 BLOCK 包裹就能出来，不需要 h1，也不需要 ** 与 ` 这些行内标记
   * （它们会把站方自己的排版符号当字面量抄进去）。 */
  const PLAIN_BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption", "div", "figure", "section", "pre", "table", "tr"]);
  const PLAIN_DROP = new Set(["script", "style", "noscript"]);

  const squash = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  /* 三套空白归一，各站原本就不一样，收敛时原样保留：
   *   strip   行尾/行首空白清掉（澎湃、老 walk）
   *   squash  连续空格压成一个（豆瓣/派早/值得买，正文里有大量排版空格）
   *   wechat  只清行尾，保留行首（公众号正文靠行首空格做缩进） */
  const NORMALIZE = {
    strip: (text) => text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    squash: (text) => text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim(),
    wechat: (text) => text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim(),
  };

  function walkWith(root, options = {}) {
    const out = [];
    const seen = new Set();
    const push = (text) => { if (text) out.push(text); };
    const block = options.block || BLOCK;
    const drop = options.drop || DROP;
    const list = options.list || { ordered: true, wrapBlock: false, trailing: true };
    const quote = options.quote || { blockquote: true, figcaption: true };
    /* 块边界的换行数。两块之间最终都会被 NORMALIZE 压成空一行，所以这里的
     * 1 与 2 只影响「文本节点自己以换行开头/结尾」这类边界情况——保留原值是为了
     * 让三站迁移时逐字符不变，不是为了对外区分。 */
    const pad = options.pad === undefined ? "\n\n" : options.pad;
    const inline = !!options.inline;
    const heading = options.heading || "full";
    const link = options.link || null;
    const base = options.base || (typeof location !== "undefined" ? location.href : "");
    const state = { unsupported: 0, truncated: false };
    const api = {
      push,
      state,
      /* 媒体去重放在站点手里：澎湃要先判 m3u8 再计入 seen，顺序不能换。
       * 去重是共享的（同一份 seen），占位符长什么样由站点的 onMedia 决定。 */
      fresh(url) {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      },
      seen,
      /* 媒体数量上限由站点自己算（它才持有 media 数组）。超限的这张不登记、
       * 也不计入 seen——否则同 URL 之后再出现会被当重复静默丢掉。 */
      overLimit() {
        return !!(options.overLimit && options.overLimit(api));
      },
      /* 登记一个媒体并写出占位符。返回 true 表示这次真的记下了。
       * 视频/音频也走这里，站点用 kind 区分要写成 \u0000 还是别的样子。
       * dedupeMedia:false 时不去重——公众号每张图都要在正文里留一次引用，
       * 去重只该省下载，不该省引用。 */
      emit(url, kind, index) {
        if (api.overLimit()) return false;
        if (options.dedupeMedia === false) {
          if (seen.has(url)) {
            push(options.onMedia ? (options.onMedia(url, kind, api, index) || "") : "");
            return true;
          }
          seen.add(url);
        } else if (!api.fresh(url)) {
          return false;
        }
        push(options.onMedia ? (options.onMedia(url, kind, api, index) || "") : "");
        return true;
      },
    };
    /* 图片出现次数（含重复）。站点自定义命名要按「第几次出现」编号时用它。 */
    let imageCount = 0;

    const dropped = (tag) => (drop instanceof RegExp ? drop.test(tag) : drop.has(tag));

    function visit(node) {
      if (node.nodeType === 3) {
        if (options.squashText) {
          const text = node.nodeValue.replace(/\s+/g, " ");
          if (text.trim()) push(text);
        } else {
          push(node.nodeValue.replace(/\u00a0/g, " "));
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (dropped(tag)) return;
      if (options.skip && options.skip(node)) return;
      /* 站点私有的节点语义（商品卡片、视频卡片、iframe 提示）在这里拦，
       * 返回 true 表示已经处理完，别再往下走。 */
      if (options.node && options.node(node, api, tag)) return;

      if (tag === "img") {
        if (options.onMedia) {
          /* 站点自己的 imageUrl() 负责「哪张图不要、要哪一档」，onMedia 只管占位符长什么样，
           * 两件事必须都落到同一个 URL 上，否则去重集合和实际下载的图会对不上。
           * index 是这张图在正文里第几次出现（从 0 起），命名策略按出现次序编号时用它。 */
          const url = options.mediaUrl
            ? options.mediaUrl(node, "image")
            : (options.imageUrl ? options.imageUrl(node) : node.getAttribute("src"));
          if (!url) return;
          const index = imageCount++;
          api.emit(url, "image", index);
        } else {
          addImage(node);
        }
        return;
      }
      if (tag === "br") { push("\n"); return; }
      /* 分隔线固定两侧各一空行，不吃 pad——站点之间这一处本来就是一致的。 */
      if (tag === "hr" && options.hr) { push("\n\n---\n\n"); return; }

      if (/^h[1-6]$/.test(tag) && heading !== "none") {
        const level = Number(tag[1]);
        if (heading === "full") {
          push(pad + "#".repeat(level) + " ");
          for (const child of node.childNodes) visit(child);
          push(pad);
          return;
        }
        /* h234：只认二到四级标题，其余当普通块。行首行尾各一个换行。 */
        if (level >= 2 && level <= 4) {
          push("\n" + "#".repeat(level) + " ");
          for (const child of node.childNodes) visit(child);
          push("\n");
          return;
        }
      }

      if (inline && (tag === "strong" || tag === "b")) {
        push("**");
        for (const child of node.childNodes) visit(child);
        push("**");
        return;
      }
      if (inline && (tag === "em" || tag === "i")) {
        push("*");
        for (const child of node.childNodes) visit(child);
        push("*");
        return;
      }
      if (inline && tag === "code") {
        push("`");
        for (const child of node.childNodes) visit(child);
        push("`");
        return;
      }

      if (tag === "a" && link) {
        const text = squash(node.textContent);
        if (link === "wechat") {
          /* 公众号：只有站外 http(s) 写成链接，站内跳转只留文字 */
          const href = node.getAttribute("href") || "";
          if (!text) return;
          if (/^https?:\/\//i.test(href) && !/^https?:\/\/mp\.weixin\.qq\.com\//i.test(href)) {
            push(`[${text}](${href})`);
          } else {
            push(text);
          }
          return;
        }
        if (!node.querySelector("img")) {
          try {
            const href = new URL(node.getAttribute("href") || "", base);
            if (text && /^https?:$/.test(href.protocol)) {
              push(`[${text}](${href.href})`);
              return;
            }
          } catch (error) {
            /* 无效地址保留链接文字，继续按普通节点走 */
          }
        }
      }

      if (tag === "li") {
        const parent = node.parentElement;
        const ordered = list.ordered && parent && parent.tagName.toLowerCase() === "ol";
        const index = ordered ? [...parent.children].indexOf(node) + 1 : 0;
        const prefix = ordered ? `${index}. ` : "- ";
        if (list.wrapBlock) push("\n");
        push("\n" + prefix);
        for (const child of node.childNodes) visit(child);
        if (list.trailing) push("\n");
        return;
      }

      if ((tag === "blockquote" && quote.blockquote) || (tag === "figcaption" && quote.figcaption)) {
        push(pad + "> ");
        for (const child of node.childNodes) visit(child);
        push(pad);
        return;
      }

      if (block.has(tag)) push(pad);
      for (const child of node.childNodes) visit(child);
      if (block.has(tag)) push(pad);
    }

    function addImage(node) {
      const url = options.imageUrl ? options.imageUrl(node) : node.getAttribute("src");
      if (!url || !api.fresh(url)) return;
      const offset = Number(options.offset) || 0;
      const index = offset + seen.size - 1;
      /* 占位符两侧留多少空行各站不同，且这些换行会进最终文本（占位符是普通字符），
       * 所以不能用 NORMALIZE 兜——必须按站原样传。 */
      const imagePad = options.imagePad === undefined ? "\n\n" : options.imagePad;
      push(imagePad + "\u0000" + index + "\u0000" + imagePad);
    }

    visit(root);
    const text = NORMALIZE[options.normalize || "strip"](out.join(""));
    return { text, images: [...seen], state };
  }

  /* 老接口：body + images。abbs / archdaily / gooood / xitek 用它。 */
  function walk(root, options = {}) {
    const result = walkWith(root, {
      ...options,
      inline: true,
      heading: "full",
      hr: true,
      link: "resolve",
      normalize: "strip",
      imageUrl: options.imageUrl,
    });
    return { body: result.text, images: result.images };
  }

  globalThis.__XHX_DOM = { walk, walkWith, squash, BLOCK, DROP, PLAIN_BLOCK, PLAIN_DROP, NORMALIZE };
})();
