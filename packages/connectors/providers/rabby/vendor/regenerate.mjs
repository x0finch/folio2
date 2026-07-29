// 重新生成 vendor/ 里那两个文件。**补丁是脚本打的,不是手改的** —— 上游发新版时跑这个,
// 别手动改 sign-patched.cjs。
//
// 为什么非得打补丁:Workers 禁止运行时编译 wasm(`Wasm code generation disallowed by embedder`,
// 同步异步都禁)。上游 bundle 在模块求值时就 `new WebAssembly.Module(内联的 base64 字节)` ——
// 触发条件正是「没有 window」,恰好是 Workers 的形状,于是当场炸。
// 唯一能走的路:把 wasm 提成 .wasm 文件让构建期编译,再把已编译的 Module 塞回去。
//
// 用法:node vendor/regenerate.mjs [版本号]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@rabby-wallet/rabby-sign";
const VERSION = process.argv[2] ?? "0.4.1";
const ENTRY = "package/umd/sign-wasm-rabby.js";

// 两处替换。命中数必须是 1/1 —— 上游改了形状就该在这里炸,而不是静默产出一个跑不起来的包。
const PATCHES = [
  ["new WebAssembly.Module(w)", "globalThis.__RABBY_WASM__"],
  ["WebAssembly.compile(w)", "Promise.resolve(globalThis.__RABBY_WASM__)"],
];

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "rabby-sign-"));

console.log(`拉 ${PKG}@${VERSION} …`);
execFileSync("npm", ["pack", `${PKG}@${VERSION}`, "--pack-destination", work], {
  stdio: ["ignore", "ignore", "inherit"],
});
const tgz = execFileSync("ls", [work]).toString().trim().split("\n")[0];
execFileSync("tar", ["xzf", join(work, tgz), "-C", work, ENTRY]);

const src = readFileSync(join(work, ENTRY), "utf8");

// —— 1. 提 wasm ——
const b64 = src.match(/"(AGFzbQ[A-Za-z0-9+/=]{1000,})"/);
if (!b64) throw new Error("找不到内联的 base64 wasm — 上游可能改了打包方式");
const wasm = Buffer.from(b64[1], "base64");
if (wasm.subarray(0, 4).toString("hex") !== "0061736d") throw new Error("提出来的不是 wasm");
writeFileSync(join(here, "rabby_sign.wasm"), wasm);

// —— 2. 打补丁 ——
let out = src;
for (const [from, to] of PATCHES) {
  const hits = out.split(from).length - 1;
  if (hits !== 1) throw new Error(`补丁点 ${JSON.stringify(from)} 命中 ${hits} 次,应为 1 次`);
  out = out.split(from).join(to);
}
writeFileSync(join(here, "sign-patched.cjs"), out);

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
console.log(`rabby_sign.wasm    ${wasm.length} 字节  sha256:${sha(wasm)}`);
console.log(`sign-patched.cjs    ${out.length} 字节  sha256:${sha(out)}`);
console.log(`来源 ${PKG}@${VERSION}`);
