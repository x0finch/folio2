// Regenerates the two files in vendor/. The patch is applied by this script, not by hand: run it when upstream releases a new version,
// and never hand-edit sign-patched.cjs.
// Why patch at all: Workers forbid runtime wasm compilation (`Wasm code generation disallowed by embedder`, sync and async), while the upstream
// bundle does `new WebAssembly.Module(inline base64 bytes)` at module evaluation whenever there is no window, which is a Worker's shape.
// The only way: extract the wasm to a .wasm file compiled at build time and hand the compiled Module back.
// Usage (from packages/upstreams/entry): node vendor/rabby/regenerate.mjs [version]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@rabby-wallet/rabby-sign";
const VERSION = process.argv[2] ?? "0.4.1";
const ENTRY = "package/umd/sign-wasm-rabby.js";

// Two replacements; each must hit exactly once, so an upstream shape change breaks here rather than silently producing an unusable bundle.
const PATCHES = [
  ["new WebAssembly.Module(w)", "globalThis.__RABBY_WASM__"],
  ["WebAssembly.compile(w)", "Promise.resolve(globalThis.__RABBY_WASM__)"],
];

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "rabby-sign-"));

console.log(`fetching ${PKG}@${VERSION} …`);
execFileSync("npm", ["pack", `${PKG}@${VERSION}`, "--pack-destination", work], {
  stdio: ["ignore", "ignore", "inherit"],
});
const tgz = execFileSync("ls", [work]).toString().trim().split("\n")[0];
execFileSync("tar", ["xzf", join(work, tgz), "-C", work, ENTRY]);

const src = readFileSync(join(work, ENTRY), "utf8");

// 1. Extract the wasm
const b64 = src.match(/"(AGFzbQ[A-Za-z0-9+/=]{1000,})"/);
if (!b64) throw new Error("inline base64 wasm not found: upstream may have changed its bundling");
const wasm = Buffer.from(b64[1], "base64");
if (wasm.subarray(0, 4).toString("hex") !== "0061736d") throw new Error("extracted bytes are not wasm");
writeFileSync(join(here, "rabby_sign.wasm"), wasm);

// 2. Patch
let out = src;
for (const [from, to] of PATCHES) {
  const hits = out.split(from).length - 1;
  if (hits !== 1) throw new Error(`patch point ${JSON.stringify(from)} hit ${hits} times, expected 1`);
  out = out.split(from).join(to);
}
writeFileSync(join(here, "sign-patched.cjs"), out);

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
console.log(`rabby_sign.wasm    ${wasm.length} bytes  sha256:${sha(wasm)}`);
console.log(`sign-patched.cjs    ${out.length} bytes  sha256:${sha(out)}`);
console.log(`source ${PKG}@${VERSION}`);
