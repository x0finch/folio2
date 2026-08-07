import type { Balance, BalanceProvider, ConnectorError } from "@folio/connectors-basic";
import { validateCredentials } from "@folio/connectors-basic";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evmAccountCreds, resetChainIdsCacheForTests, zerionProvider } from "../src";

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError>): Promise<A> => Effect.runPromise(effect);

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 擦除版类型(= 进 registry 后暴露形状),ctx 的 creds 走宽松 map,与旧测一致。
const provider: BalanceProvider<Balance> = zerionProvider;

// 新 FetchContext 形状:account.creds(AC:address)+ creds(PC:ZERION_API_KEY)。
function ctx(address: string, creds: Record<string, string>) {
  return {
    account: { id: "a1", label: "Wallet", connectorId: "evm", creds: { address } },
    creds,
  };
}

beforeEach(() => {
  resetChainIdsCacheForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("zerion provider.validateAccount", () => {
  // 地址格式由 validateCredentials 预校验;validateAccount 只对 provider key 缺失自查(不发请求)。
  it("returns false when the provider key is missing, WITHOUT a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await run(provider.validateAccount(ctx(ADDR, {})))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("hits the lightweight portfolio endpoint and returns true on 200", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect(await run(provider.validateAccount(ctx(ADDR, { ZERION_API_KEY: "k" })))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain(`/v1/wallets/${ADDR}/portfolio`);
  });

  it("returns false on 401/403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await run(provider.validateAccount(ctx(ADDR, { ZERION_API_KEY: "k" })))).toBe(false);
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;守住脏 address 快速失败,见 sync-deps 桥)。
describe("evm account.creds validator gate", () => {
  it("接受合法 EVM 地址", async () => {
    await expect(validateCredentials(evmAccountCreds, { address: ADDR })).resolves.toEqual({
      address: ADDR,
    });
  });

  it("拒非法/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(evmAccountCreds, { address: "nope" })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(evmAccountCreds, {})).rejects.toThrow(/address/);
  });
});
