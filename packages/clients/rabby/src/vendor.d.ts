// vendor/ 那两个文件的类型声明。**放在 src 且由 sign.ts 三斜线引用**,不是随便摆的:
// 内部包不构建、消费者(@folio/connectors)直接编译本包的源,所以它的 tsc program 里也得有这两条
// 声明 —— 而环境声明只在「文件进了 program」时生效。三斜线引用就是把它带进去的那根线。
// (少了它,entry 的 typecheck 会报 Cannot find module '../vendor/rabby_sign.wasm'。)

// Workers 运行时(经 wrangler / @cloudflare/vite-plugin)把 `.wasm` 解析成**构建期编译好**的
// WebAssembly.Module —— 不是 URL、不是字节。为什么非得这样见 vendor/regenerate.mjs。
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

// 打过补丁的上游签名包(混淆产物,没有能用的类型)。只声明我们真正调的两个函数 ——
// 声明得越少,上游改形状时越早在编译期被发现。
declare module "*/sign-patched.cjs" {
  export interface RabbySignature {
    ts: string | number;
    nonce: string;
    version: string;
    signature: string;
  }

  // 初始化 wasm(上游叫 lW)。参数是「宿主指纹」,会进签名计算,必须传(见 src/sign.ts)。
  export function lW(hostFingerprint?: string): Promise<unknown>;

  // 算签名(上游叫 cattleGsW)。参数顺序就是 (query 参数, HTTP 方法, 路径)。
  export function cattleGsW(
    params: Record<string, unknown>,
    method: string,
    path: string,
  ): RabbySignature;
}
