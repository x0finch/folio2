/// <reference path="./vendor.d.ts" />
import { SigningFailure, summaryOf } from "@folio/client-core";
import { Effect } from "effect";
import RABBY_WASM from "../vendor/rabby_sign.wasm";
import type { RabbySignature } from "../vendor/sign-patched.cjs";
import { RABBY_CLIENT, RABBY_CLIENT_VERSION } from "./constants";

// rabby 请求签名。**不签不是「401」而是「限速档位」** —— 实测同一 IP 同一端点:签了名 20 连发全过,
// 没签就是 2 发之后 429、没有 Retry-After、等 45s 还是 429。所以签名是刚需,不是可选优化。
//
// wasm 怎么进 Worker(这段别改成「直接 import 上游包」):
// Workers **禁止运行时编译 wasm**(`Wasm code generation disallowed by embedder`,同步异步都禁),
// 而上游 bundle 在模块求值时就 `new WebAssembly.Module(内联 base64)` —— 触发条件正是「没有 window」,
// 恰好是 Workers 的形状。所以走 vendor:wasm 提成 .wasm 文件由构建期编译,已编译的 Module 经
// `globalThis.__RABBY_WASM__` 塞给打过补丁的 bundle。补丁由 vendor/regenerate.mjs 生成,勿手改。

// 已编译 Module 交接用的全局键。**必须在 import 那份补丁包之前设好** —— 它在模块求值时就要用。
const WASM_HANDOFF_KEY = "__RABBY_WASM__";

// 宿主指纹:浏览器扩展里是 chrome-extension://<扩展 id>/bridge.html。它会进签名计算,所以必须传,
// 但上游目前不校验内容 —— 随机 id 实测可用(workerd 里算出的签名真打 rabby 20/20 个 200)。
// 哪天开始校验,这里就是第一个断的地方。
//
// **这里用 `Math.random()` 而不是 Effect 的 `Random`**:它不是业务随机、不需要可复现,
// 而且只在 wasm 初始化那一次调用 —— 走服务反而要把整个加载路径染成 Effect。
const hostFingerprint = (): string =>
  `chrome-extension://${Math.random().toString(36).slice(2)}/bridge.html`;

type Signer = {
  cattleGsW(params: Record<string, unknown>, method: string, path: string): RabbySignature;
};

// 懒加载 + 只加载一次(isolate 级)。**别提到模块顶层** —— Worker 有启动 CPU 预算,
// wasm 实例化不该进启动路径(CLAUDE.md 里 better-auth 那条踩过同一个坑)。
let signerPromise: Promise<Signer> | null = null;

type LoadedSigner = Signer & { lW?: (hf?: string) => Promise<unknown> };

const usable = (v: unknown): v is Required<LoadedSigner> =>
  typeof (v as LoadedSigner)?.lW === "function" &&
  typeof (v as LoadedSigner)?.cattleGsW === "function";

async function loadSigner(): Promise<Signer> {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[WASM_HANDOFF_KEY] = RABBY_WASM;
  const mod = await import("../vendor/sign-patched.cjs");
  // 上游那份是 UMD,落到哪个形状取决于打包器怎么看它:CJS 互操作 → `default`;当 ESM 求值 →
  // `module`/`exports`/`define` 全 undefined,于是它走最后一支把自己挂到 `self.RabbySign`。
  // 三种都接 —— 文件名给 `.cjs` 是为了拿到第一种,后两种是安全网。
  const signer = [
    (mod as { default?: unknown }).default,
    mod,
    (globals as { RabbySign?: unknown }).RabbySign,
  ].find(usable);
  if (!signer) {
    throw new Error("rabby-sign: vendored bundle is missing lW/cattleGsW");
  }
  await signer.lW(hostFingerprint());
  return signer;
}

function signer(): Promise<Signer> {
  // 失败不缓存:一次加载失败不该让这个 isolate 永久签不了名。
  signerPromise ??= loadSigner().catch((err) => {
    signerPromise = null;
    throw err;
  });
  return signerPromise;
}

// 签名头。`params` 要和真正发出去的 query 完全一致 —— 签的就是它(上游按 key 排序后进哈希)。
//
// **失败走 `SigningFailure`,不是传输故障** —— 这正是 client-core 分出那个错误类型的原因:
// 签不出来通常意味着上游改了签名协议(要重新 vendoring),重试是白赔往返。
export function signRabbyRequest(
  method: string,
  path: string,
  params: Record<string, unknown>,
): Effect.Effect<Record<string, string>, SigningFailure> {
  return Effect.tryPromise({
    try: async () => {
      const { ts, nonce, version, signature } = (await signer()).cattleGsW(params, method, path);
      return {
        "X-Api-Ts": encodeURIComponent(String(ts)),
        "X-Api-Nonce": encodeURIComponent(nonce),
        "X-Api-Ver": encodeURIComponent(version),
        "X-Api-Sign": encodeURIComponent(signature),
        "X-Client": RABBY_CLIENT,
        "X-Version": RABBY_CLIENT_VERSION,
      };
    },
    catch: (cause) => new SigningFailure({ where: path, cause: summaryOf(cause) }),
  });
}
