import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { validateCredentials } from "@folio/connectors-basic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evmAccountCreds, resetChainIdsCacheForTests, zerionProvider } from "../src";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 擦除版类型(= 进 registry 后暴露形状),ctx 的 creds 走宽松 map,与旧测一致。
const provider: BalanceProvider<Balance> = zerionProvider;

// 新 FetchContext 形状:account.creds(AC:identifier)+ creds(PC:ZERION_API_KEY)。
function ctx(identifier: string, creds: Record<string, string>) {
  return {
    account: { id: "a1", label: "Wallet", connectorId: "evm", creds: { identifier } },
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
    expect(await provider.validateAccount(ctx(ADDR, {}))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("hits the lightweight portfolio endpoint and returns true on 200", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect(await provider.validateAccount(ctx(ADDR, { ZERION_API_KEY: "k" }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain(`/v1/wallets/${ADDR}/portfolio`);
  });

  it("returns false on 401/403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await provider.validateAccount(ctx(ADDR, { ZERION_API_KEY: "k" }))).toBe(false);
  });
});

describe("zerion provider.validateCreds", () => {
  it("presence check: true when key present, false when absent", async () => {
    expect(await provider.validateCreds?.({ ZERION_API_KEY: "k" })).toBe(true);
    expect(await provider.validateCreds?.({})).toBe(false);
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;守住脏 identifier 快速失败,见 sync-deps 桥)。
describe("evm account.creds validator gate", () => {
  it("接受合法 EVM 地址", async () => {
    await expect(validateCredentials(evmAccountCreds, { identifier: ADDR })).resolves.toEqual({
      identifier: ADDR,
    });
  });

  it("拒非法/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(evmAccountCreds, { identifier: "nope" })).rejects.toThrow(
      /identifier/,
    );
    await expect(validateCredentials(evmAccountCreds, {})).rejects.toThrow(/identifier/);
  });
});
