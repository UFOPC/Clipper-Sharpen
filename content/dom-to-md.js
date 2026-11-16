/* 通用 DOM → Markdown（文本、标题、列表、链接、图片占位符）。 */
(() => {
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "div", "dl", "dt", "dd", "figure",
    "figcaption", "footer", "header", "ol", "p", "pre", "section", "table", "tbody",
    "thead", "tfoot", "tr", "ul",
  ]);
  const DROP = new Set(["script", "style", "noscript", "svg", "input", "button", "iframe", "video", "audio", "source", "track"]);
  const squash = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  function walk(root, options = {}) {
    const out = [];
    const images = [];
    const seen = new Set();
    const offset = Number(options.offset) || 0;
    const push = (text) => { if (text) out.push(text); };

    function addImage(node) {
      const url = options.imageUrl ? options.imageUrl(node) : node.getAttribute("src");
      if (!url || seen.has(url)) return;
      seen.add(url);
      images.push(url);
      push("\n\n\u0000" + (offset + images.length - 1) + "\u0000\n\n");
    }

    function visit(node) {
      if (node.nodeType === 3) {
        push(node.nodeValue.replace(/\u00a0/g, " "));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (DROP.has(tag)) return;
      if (options.skip && options.skip(node)) return;
      if (tag === "img") { addImage(node); return; }
      if (tag === "br") { push("\n"); return; }
      if (tag === "hr") { push("\n\n---\n\n"); return; }
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
        try {
          const href = new URL(node.getAttribute("href") || "", options.base || location.href);
          if (text && /^https?:$/.test(href.protocol)) {
            push(`[${text}](${href.href})`);
            return;
          }
        } catch (error) {}
      }
      if (tag === "li") {
        const ordered = node.parentElement?.tagName.toLowerCase() === "ol";
        const index = ordered ? [...node.parentElement.children].indexOf(node) + 1 : 0;
        push("\n" + (ordered ? `${index}. ` : "- "));
        for (const child of node.childNodes) visit(child);
        push("\n");
        return;
      }
      if (tag === "blockquote" || tag === "figcaption") {
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
    return {
      body: out.join("").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      images,
    };
  }

  globalThis.__XHX_DOM = { walk, squash };
})();
