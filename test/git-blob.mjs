/* 一次性小工具：从 git 里取某个文件的 HEAD 版本，去掉 BOM 写到临时目录，
 * 供「这组用例能不能抓到旧实现」那种验证使用。
 *
 * 用文件而不是 node -e：PowerShell 5.1 对内联引号的转义会吃掉反斜杠，
 * 已经因此假绿过一次（副本没生成，跑的还是新代码）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [file, rev = "HEAD"] = process.argv.slice(2);
if (!file) {
  console.error("用法: node test/git-blob.mjs <仓库相对路径> [rev]");
  process.exit(2);
}
const raw = execFileSync("git", ["show", `${rev}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
const text = raw.toString("utf8").replace(/^\uFEFF/, "");
const out = path.join(os.tmpdir(), "legacy-" + path.basename(file));
fs.writeFileSync(out, text, "utf8");
console.log(out);
console.log(`lines=${text.split("\n").length} bytes=${Buffer.byteLength(text, "utf8")}`);
