import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { validateCredentials } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidAccountCreds, hyperliquidProvider } from "../src";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 擦除版类型(= 进 registry 后暴露形状),ctx 的 creds 走宽松 map,与其它 provider 测一致。
const provider: BalanceProvider<Balance> = hyperliquidProvider;

// 新 FetchContext 形状:account.creds(AC:address)+ creds(PC,恒空)。
function ctx(address: string) {
  return {
    account: { id: "a1", label: "HL", connectorId: "hyperliquid", creds: { address } },
    creds: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hyperliquidProvider.validateAccount", () => {
  it("returns true when the address probes the info endpoint with 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await provider.validateAccount(ctx(ADDR))).toBe(true);
  });

  // 地址格式校验已上移到 validateCredentials;validateAccount 直接探活(不再预检地址)。
  it("returns false on non-ok response or network error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    expect(await provider.validateAccount(ctx(ADDR))).toBe(false);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await provider.validateAccount(ctx(ADDR))).toBe(false);
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;守住脏 address 快速失败,见 sync-deps 桥)。
describe("hyperliquid account.creds validator gate", () => {
  it("接受合法 EVM 地址", async () => {
    await expect(validateCredentials(hyperliquidAccountCreds, { address: ADDR })).resolves.toEqual({
      address: ADDR,
    });
  });

  it("拒非法/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(hyperliquidAccountCreds, { address: "nope" })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(hyperliquidAccountCreds, {})).rejects.toThrow(/address/);
  });
});
