/* ABBS 楼主判定：重名与匿名都不能把回帖并进正文。
 *
 * 旧实现用 `author === nick` 判楼主。ABBS 允许昵称重复，于是：
 *   ① 同名网友的回帖被当成楼主帖并进正文
 *   ② 一堆匿名回帖全叫「匿名」，全被当成楼主的话
 * 这两条在真站上很难复现（要蹲到一个重名网友），所以只能靠合成 DOM 守住。
 *
 * 现在的判定顺序是「认 uid，认不到就只认第一楼」，后者会往 warnings 里
 * 写一句提示——不能静默降级，否则用户会以为整帖都收全了。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = process.env.EXT_DIR || path.resolve(".");
const domSource = fs.readFileSync(path.join(EXT, "content", "dom-to-md.js"), "utf8");
/* ABBS_SRC 可以指到一份改过的副本上，用来验证这组用例确实能抓到旧实现
 * 的错误——一个永远不会失败的测试等于没有测试。 */
const abbsSource = fs.readFileSync(process.env.ABBS_SRC || path.join(EXT, "content", "abbs.js"), "utf8");

/* ---------- 够用的假 DOM ---------- */
class Node {
  constructor(type, tag, attrs = {}) {
    this.nodeType = type;
    this.tagName = (tag || "").toUpperCase();
    this._attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
    this._classes = new Set();
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
    return this;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((n) => n.textContent).join("");
  }
  get classList() {
    return {
      contains: (name) => this._classes.has(name),
    };
  }
  /* 只实现测试里用到的选择器：标签名、"b"、":scope > td" */
  querySelectorAll(selector) {
    const want = selector.replace(":scope > ", "").toLowerCase();
    return this.children.filter((c) => c.tagName.toLowerCase() === want);
  }
  querySelector(selector) {
    if (selector.startsWith("a[")) {
      /* a[href*="user.php"], a[href*="uid="] —— 只按前缀判断即可 */
      const needle = /href\*="([^"]+)"/.exec(selector)?.[1] || "";
      const walk = (node) => {
        if (node.nodeType !== 1) return null;
        if (node.tagName.toLowerCase() === "a" && String(node.getAttribute("href") || "").includes(needle)) return node;
        for (const child of node.children) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
    /* 测试只用到 "span.javascript" 这一种带 class 的选择器 */
    const [rawTag, rawClass] = selector.toLowerCase().split(".");
    const want = rawTag;
    const wantClass = rawClass || "";
    const walk = (node) => {
      if (node.nodeType !== 1) return null;
      const tagHit = node.tagName.toLowerCase() === want;
      const classHit = !wantClass || node._classes.has(wantClass) || String(node.getAttribute("class") || "").split(/\s+/).includes(wantClass);
      if (tagHit && classHit) return node;
      for (const child of node.children) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}
const text = (value) => {
  const node = new Node(3, "");
  node.nodeValue = value;
  return node;
};
const el = (tag, attrs, ...children) => {
  const node = new Node(1, tag, attrs);
  for (const c of children) node.append(typeof c === "string" ? text(c) : c);
  return node;
};

/* 一楼一个 tr.odd：td0 = 作者（b + 可选 uid 链接），td1 = 时间 + span.javascript 正文 */
function floor({ nick, uid, stamp, body }) {
  const authorCell = el("td", {}, el("b", {}, nick));
  if (uid) authorCell.append(el("a", { href: `/bbs/user.php?uid=${uid}` }, "资料"));
  const bodyNode = el("span", { class: "javascript" }, body);
  const timeCell = el("td", {}, stamp, bodyNode);
  return el("tr", { class: "odd" }, authorCell, timeCell);
}

function makeDoc(floors) {
  const doc = {
    title: "一层楼测试帖 - ABBS 论坛",
    querySelectorAll(selector) {
      if (selector === "tr.odd") return floors;
      if (selector === "a") return [];
      return [];
    },
    body: el("body"),
  };
  return doc;
}

/* ---------- 把 abbs.js 的 parsePage 放进沙箱跑 ---------- */
function buildSandbox() {
  const ctx = vm.createContext({ URL, console, Date, DOMParser: class {}, fetch: async () => {} });
  ctx.globalThis = ctx;
  vm.runInContext("globalThis.__XHX_DOM = undefined;", ctx);
  vm.runInContext(domSource, ctx);
  /* mount 只是注册，这里给个空实现，别让它抛 */
  vm.runInContext("globalThis.__XHX_CLIP = { mount() {} };", ctx);
  vm.runInContext(abbsSource, ctx);
  /* parsePage 在 IIFE 里，外部拿不到；从源码里抠出来单独求值 */
  const start = abbsSource.indexOf("function parsePage(");
  let depth = 0;
  let i = abbsSource.indexOf("{", start);
  for (; i < abbsSource.length; i++) {
    if (abbsSource[i] === "{") depth++;
    else if (abbsSource[i] === "}" && --depth === 0) break;
  }
  const body = abbsSource.slice(start, i + 1);
  const helpers = [
    "const MATCH = /^\\/(?:bbs\\/post\\/view|news\\/read\\.php|topic\\/read\\.php)$/;",
    "const MAX_PAGES = 20;",
    "const squash = globalThis.__XHX_DOM.squash;",
    "const clean = (value) => String(value || '').replace(/\\r/g, '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();",
    "function abs(raw, base) { try { const url = new URL(raw || '', base); if (!/^https?:$/.test(url.protocol)) return ''; return url.href; } catch (e) { return ''; } }",
    body,
    "globalThis.__parsePage = parsePage;",
  ].join("\n");
  vm.runInContext(helpers, ctx);
  return ctx.__parsePage;
}

const parsePage = buildSandbox();
const LOC = new URL("https://www.abbs.com.cn/bbs/post/view?id=999999");

let bad = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (!cond) {
    bad++;
    if (extra) console.log("        " + extra);
  }
};

/* [1] 同名但 uid 不同：只认楼主那一层，另一层算回帖 */
{
  const doc = makeDoc([
    floor({ nick: "老王", uid: "1001", stamp: "2026-01-01 10:00", body: "楼主正文" }),
    floor({ nick: "老王", uid: "2002", stamp: "2026-01-01 11:00", body: "重名网友的回帖" }),
  ]);
  const info = parsePage(doc, LOC, 0);
  check("[1] 重名网友的回帖不进正文", info.body === "楼主正文", `body=${JSON.stringify(info.body)}`);
  check("[1] 重名网友的回帖进评论", info.comments.some((c) => c.text.includes("重名网友")), JSON.stringify(info.comments));
  check("[1] 认出 uid 时不该有降级提示", info.warnings.length === 0, JSON.stringify(info.warnings));
}

/* [2] 楼主在同一帖里回第二次：uid 相同，仍算正文 */
{
  const doc = makeDoc([
    floor({ nick: "老王", uid: "1001", stamp: "2026-01-01 10:00", body: "楼主一" }),
    floor({ nick: "老王", uid: "1001", stamp: "2026-01-01 10:05", body: "楼主补充" }),
  ]);
  const info = parsePage(doc, LOC, 0);
  check("[2] 楼主自己补的楼层仍算正文", info.body.includes("楼主一") && info.body.includes("楼主补充"), JSON.stringify(info.body));
  check("[2] 楼主自己的楼层不进评论", info.comments.length === 0, JSON.stringify(info.comments));
}

/* [3] 全是匿名回帖：旧实现会把它们全并进正文 */

{
  const doc = makeDoc([
    floor({ nick: "匿名", stamp: "2026-01-01 10:00", body: "真正的楼主" }),
    floor({ nick: "匿名", stamp: "2026-01-01 11:00", body: "匿名的路人甲" }),
    floor({ nick: "匿名", stamp: "2026-01-01 12:00", body: "匿名的路人乙" }),
  ]);
  const info = parsePage(doc, LOC, 0);
  check("[3] 匿名回帖不全并进正文", !info.body.includes("路人甲") && !info.body.includes("路人乙"), JSON.stringify(info.body));
  check("[3] 匿名回帖进评论", info.comments.length === 2, `comments=${info.comments.length}`);
  check("[3] 拿不到 uid 时留一句提示", info.warnings.some((w) => w.includes("uid")), JSON.stringify(info.warnings));
}

/* [4] 拿不到 uid 时只认第一楼，且第一楼依旧是正文 */
{
  const doc = makeDoc([
    floor({ nick: "楼主甲", stamp: "2026-01-01 10:00", body: "第一楼正文" }),
    floor({ nick: "楼主甲", stamp: "2026-01-01 10:05", body: "同一人的第二楼" }),
  ]);
  const info = parsePage(doc, LOC, 0);
  check("[4] 无 uid 时第一楼是正文", info.body === "第一楼正文", JSON.stringify(info.body));
  check("[4] 无 uid 时同昵称第二楼按回帖处理", info.comments.length === 1, `comments=${info.comments.length}`);
  check("[4] 降级必须留痕", info.warnings.some((w) => w.includes("uid")), JSON.stringify(info.warnings));
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ ABBS 楼主判定：重名与匿名都不再污染正文");
process.exit(bad ? 1 : 0);
