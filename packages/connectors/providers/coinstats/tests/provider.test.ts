import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { validateCredentials } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coinstatsAccountCreds, createCoinstatsProvider } from "../src";
import solanaFixture from "./fixtures/solana.json";

const SUI = "0xc0ffee254729296a45a3885639AC7E10F9d54979c0ffee254729296a45a38856";

// 新 FetchContext 形状:account.creds(AC:address)+ creds(PC:COINSTATS_API_KEY)。
// PC 现在承载 provider key(旧 globalKeys 退场)。擦除版类型(= 进 registry 后 manifest 暴露形状)。
function ctx(overrides?: { address?: string; creds?: Record<string, string> }) {
  return {
    account: {
      id: "a1",
      label: "Wallet",
      connectorId: "solana",
      creds: { address: overrides?.address ?? "addr" },
    },
    creds: overrides?.creds ?? { COINSTATS_API_KEY: "k" },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("coinstats factory (一个 provider 包 → 多个 connector)", () => {
  it("每个 connectionId 产出 id=coinstats 的 provider,声明 COINSTATS_API_KEY creds", () => {
    for (const cid of ["solana", "sui-wallet", "cosmos"]) {
      const p = createCoinstatsProvider(cid);
      expect(p.id).toBe("coinstats");
      expect(p.creds.map((c) => c.key)).toEqual(["COINSTATS_API_KEY"]);
    }
  });

  it("绑定各自的 connectionId(sui → 'sui-wallet')", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));
    const sui: BalanceProvider<Balance> = createCoinstatsProvider("sui-wallet");
    await sui.fetchBalances(ctx({ address: SUI }));
    expect(String(spy.mock.calls[0][0])).toContain("connectionId=sui-wallet");
  });
});

describe("coinstats fetchBalances", () => {
  const provider: BalanceProvider<Balance> = createCoinstatsProvider("solana");

  it("sends X-API-KEY and parses balances", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(solanaFixture), { status: 200 }));
    const balances = await provider.fetchBalances(ctx());
    expect(balances).toHaveLength(4); // solana fixture 5 条,1 条无 symbol 被跳过
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
  });

  // 地址由 validateCredentials 预校验;provider 只对 provider key 缺失自查(不发请求)。
  it("throws INVALID_CREDENTIALS when the provider key is missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(provider.fetchBalances(ctx({ creds: {} }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

describe("coinstats validateAccount", () => {
  const provider: BalanceProvider<Balance> = createCoinstatsProvider("solana");

  it("false when the provider key is missing, without a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await provider.validateAccount(ctx({ creds: {} }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true on 200, false on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await provider.validateAccount(ctx())).toBe(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await provider.validateAccount(ctx())).toBe(false);
  });
});

describe("coinstats provider.validateCreds — 实测打 /wallet/blockchains(只需 key)", () => {
  const provider: BalanceProvider<Balance> = createCoinstatsProvider("solana");

  it("key 缺失/空 → false,且不发请求", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await provider.validateCreds?.({ COINSTATS_API_KEY: "" })).toBe(false);
    expect(await provider.validateCreds?.({})).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("打 /wallet/blockchains:200 → true(带 X-API-KEY);401 → false", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await provider.validateCreds?.({ COINSTATS_API_KEY: "k" })).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/wallet/blockchains");
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await provider.validateCreds?.({ COINSTATS_API_KEY: "k" })).toBe(false);
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;三链共享此声明,格式交 API 判定 → 仅非空)。
describe("coinstats account.creds validator gate", () => {
  it("接受非空地址(trim 后)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: SUI })).resolves.toEqual({
      address: SUI,
    });
  });

  it("拒空/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: "  " })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(coinstatsAccountCreds, {})).rejects.toThrow(/address/);
  });
});
