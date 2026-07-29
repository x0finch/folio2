import { describe, expect, it } from "vitest";
import { RABBY_CLIENT, RABBY_CLIENT_VERSION } from "../../src/constants";
import { signRabbyRequest } from "../../src/sign";

// 【在 workerd 里跑】—— 这是整个 vendoring 方案的守卫测试。
//
// 它证明的是「上游那个包在 Workers 的运行时约束下确实能出签名」:Workers **禁止运行时编译 wasm**
// (`new WebAssembly.Module(bytes)` / `WebAssembly.compile(bytes)` 都抛
// `CompileError: Wasm code generation disallowed by embedder`),所以 vendor/ 那两个文件才存在 ——
// wasm 提成 .wasm 由构建期编译,已编译的 Module 经 globalThis 塞回打过补丁的 bundle。
//
// **这个文件不能搬到普通 node vitest 去**:node 允许运行时编译 wasm,在那儿全都会过,
// 于是补丁掉了、vendor 坏了都测不出来 —— 假绿灯比没测更糟。
//
// 签名值本身没法做 golden(带时间戳和 nonce,每次都不同),所以断言的是「形状 + 不变量」。

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PATH = "/v1/user/total_balance";

describe("signRabbyRequest(在 workerd 里)", () => {
  it("wasm 实例化得起来,六个头齐全", async () => {
    // 这一条就是主张:如果 vendoring 坏了(补丁没打上 / wasm 文件不对 / 上游改了导出名),
    // 这里会抛 CompileError 或 "missing lW/cattleGsW",而不是悄悄产出错的签名。
    const h = await signRabbyRequest("GET", PATH, { id: ADDR });
    expect(Object.keys(h).sort()).toEqual([
      "X-Api-Nonce",
      "X-Api-Sign",
      "X-Api-Ts",
      "X-Api-Ver",
      "X-Client",
      "X-Version",
    ]);
  });

  it("签名是 64 位 hex(sha256 的形状)", async () => {
    const h = await signRabbyRequest("GET", PATH, { id: ADDR });
    expect(h["X-Api-Sign"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("时间戳是秒级、且贴近当下(不是毫秒、不是 0)", async () => {
    const h = await signRabbyRequest("GET", PATH, { id: ADDR });
    const ts = Number(h["X-Api-Ts"]);
    expect(Number.isInteger(ts)).toBe(true);
    // 秒级:与 Date.now()/1000 相差在 1 分钟内。若上游哪天改成毫秒,这里会红。
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(60);
  });

  it("版本是 v2,客户端头取自 constants(不在两处各写一遍)", async () => {
    const h = await signRabbyRequest("GET", PATH, { id: ADDR });
    expect(h["X-Api-Ver"]).toBe("v2");
    expect(h["X-Client"]).toBe(RABBY_CLIENT);
    expect(h["X-Version"]).toBe(RABBY_CLIENT_VERSION);
  });

  it("nonce 每次都不同 —— 否则重放保护是假的", async () => {
    const a = await signRabbyRequest("GET", PATH, { id: ADDR });
    const b = await signRabbyRequest("GET", PATH, { id: ADDR });
    expect(a["X-Api-Nonce"]).not.toBe(b["X-Api-Nonce"]);
    expect(a["X-Api-Sign"]).not.toBe(b["X-Api-Sign"]);
  });

  it("签的是参数 —— 换个地址签名就变(证明它没在空签)", async () => {
    // 光看「有 64 位 hex」不够:一个恒定的假签名也长这样。这条把 hash 与输入绑起来。
    const a = await signRabbyRequest("GET", PATH, { id: ADDR });
    const b = await signRabbyRequest("GET", PATH, {
      id: "0x0000000000000000000000000000000000000001",
    });
    expect(a["X-Api-Sign"]).not.toBe(b["X-Api-Sign"]);
  });

  it("并发调用共用一次初始化,都能出签名", async () => {
    // sign.ts 缓存的是 Promise 而不是结果 —— 并发首调不该各自初始化一遍 wasm。
    const all = await Promise.all(
      Array.from({ length: 5 }, () => signRabbyRequest("GET", PATH, { id: ADDR })),
    );
    for (const h of all) expect(h["X-Api-Sign"]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(all.map((h) => h["X-Api-Nonce"])).size).toBe(5);
  });
});
