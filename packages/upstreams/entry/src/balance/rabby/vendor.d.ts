// Type declarations for the two vendor/ files. Kept in src and referenced by sign.ts's triple-slash directive on purpose: internal packages are not
// built and consumers compile this package's source directly, so their tsc program needs these ambient declarations,
// which only apply when the file is in the program. Without it, their typecheck reports Cannot find module './vendor/rabby_sign.wasm'.

// The Workers runtime (via wrangler / @cloudflare/vite-plugin) resolves `.wasm` to a WebAssembly.Module compiled at build time, not a URL or bytes; see vendor/regenerate.mjs.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

// The patched upstream signing package (an obfuscated artifact with no usable types). Declares only the two functions we call: the fewer, the sooner an upstream shape change shows at compile time.
declare module "*/sign-patched.cjs" {
  export interface RabbySignature {
    ts: string | number;
    nonce: string;
    version: string;
    signature: string;
  }

  // Initialise wasm (upstream calls it lW). The argument is the host fingerprint, which enters the signature computation and must be passed (see src/sign.ts).
  export function lW(hostFingerprint?: string): Promise<unknown>;

  // Compute the signature (upstream calls it cattleGsW). Argument order is (query params, HTTP method, path).
  export function cattleGsW(
    params: Record<string, unknown>,
    method: string,
    path: string,
  ): RabbySignature;
}
