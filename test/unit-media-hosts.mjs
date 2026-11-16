/* fetchMedia 的图床白名单。
 *
 * 这个接口原本对任意 http(s) URL 开放：只要响应头是 image/*，SW 就会带着扩展
 * 的 host 权限把内容取回来。那等于在浏览器里开了一个只挡内容类型的开放代理，
 * 站点页面里的第三方脚本（或将来某个注入点）可以拿它探内网、扫端口——返回的
 * HTTP 状态码本身就足以区分「有服务」和「没有服务」，不需要图能解码成功。
 *
 * 守三件事：
 *   ① 各站真实图床要通过（含 CDN 编号子域，站点贴图常常随机落在 img1/img2/wx3）
 *   ② 内网、回环、云元数据地址必须拒绝
 *   ③ 允许的根域不能被长得像的域名骗过去（evil-doubanio.com 之类）
 */
import fs from "node:fs";
import path from "node:path";

const EXT = process.env.EXT_DIR || path.resolve(".");
const source = fs.readFileSync(path.join(EXT, "js", "background.js"), "utf8");

/* background.js 是 ESM service worker，直接 import 会触发 chrome.* 调用；
 * 只把白名单那一段抠出来求值。 */
function extractBlock(name, text) {
  const start = text.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let depth = 0;
  let i = text.indexOf("[", start);
  for (; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) break;
  }
  return text.slice(start, i + 1) + ";";
}
function extractFunction(name, text) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0;
  let i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}

const code = [
  extractBlock("MEDIA_SUFFIXES", source),
  extractFunction("mediaHostAllowed", source),
  "globalThis.__allowed = mediaHostAllowed;",
].join("\n");

const ctx = {};
new Function("globalThis", code)(ctx);
const allowed = ctx.__allowed;

let bad = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (!cond) {
    bad++;
    if (extra) console.log("        " + extra);
  }
};

/* ① 各站真实图床 —— 这些是从 content/*.js 里实际出现的域名抄来的 */
const shouldPass = [
  "https://sns-img.xhscdn.com/abc.jpg",
  "https://sns-video-hw.xhscdn.com/v.mp4",
  "https://img1.doubanio.com/view/photo/l/public/p1.jpg",
  "https://img9.doubanio.com/x.jpg",
  "https://wx1.sinaimg.cn/large/abc.jpg",
  "https://tvax3.sinaimg.cn/x.jpg",
  "https://cdnfile.sspai.com/2024/x.png",
  "https://bbs.qn.img-space.com/x.jpg",
  "https://images.adsttc.com/media/images/x/large_jpg/a.jpg",
  "https://oss.gooood.cn/2024/x.jpg",
  "https://am.zdmimg.com/202401/x.jpg",
  "https://sqcwsp-vod.smzdm.com/x.mp4",
  "https://imgpai.thepaper.cn/newspublish/x.jpg",
  "https://i2.chuimg.com/x.jpg",
];
for (const url of shouldPass) {
  check(`放行 ${new URL(url).hostname}`, allowed(url) === true, url);
}

/* ② 必须拒绝：内网、回环、云元数据、非 http */
const shouldFail = [
  "http://127.0.0.1:8080/x.jpg",
  "http://localhost/x.jpg",
  "http://192.168.1.1/x.jpg",
  "http://10.0.0.5/x.jpg",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/x.jpg",
  "http://evil.example.com/x.jpg",
  "https://raw.githubusercontent.com/a/b.png",
  "ftp://img1.doubanio.com/x.jpg",
  "javascript:alert(1)",
  "data:image/png;base64,AAAA",
  "not a url at all",
];
for (const url of shouldFail) {
  check(`拒绝 ${url.slice(0, 46)}`, allowed(url) === false, String(allowed(url)));
}

/* ③ 同形域名不能骗过后缀匹配 */
const lookalikes = [
  "https://evil-doubanio.com/x.jpg",      /* 没有点，只是名字里带 */
  "https://doubanio.com.evil.com/x.jpg",  /* 后缀在后面 */
  "https://notdoubanio.com/x.jpg",
  "https://fake.sinaimg.cn.evil.com/x.jpg",
];
for (const url of lookalikes) {
  check(`不放行同形域名 ${new URL(url).hostname}`, allowed(url) === false, String(allowed(url)));
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ fetchMedia 白名单：图床放行、内网与同形域名拒绝");
process.exit(bad ? 1 : 0);
