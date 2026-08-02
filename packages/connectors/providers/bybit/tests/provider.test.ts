import { afterEach, describe, expect, it, vi } from "vitest";
import { bybitProvider, parseUnified } from "../src";
import expected from "./fixtures/expected-unified-balances.json";
import walletBalance from "./fixtures/wallet-balance.json";

// FetchContext 形状:account.creds(AC:apiKey/secret,由分派桥 openCreds 解密后灌入)+ creds(PC:
// base URL 覆盖,#264,由 app 从 env 注入;默认空 = 直连)。Bybit 无 passphrase(异于 OKX)。
type Ctx = Parameters<typeof bybitProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s" };
function ctx(
  creds: Record<string, string> = CREDS,
  providerCreds: Record<string, string> = {},
): Ctx {
  return {
    account: { id: "a1", label: "Bybit", connectorId: "bybit", creds },
    creds: providerCreds,
  } as unknown as Ctx;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

// 两份 fixture 一一对应:wallet-balance.json(录制的 /v5/account/wallet-balance UNIFIED 响应)→
// expected-unified-balances.json。覆盖:walletBalance→amount(不含 uPnL,不用 equity)、usdValue→value
// (自带估值)、price=usdValue/amount、跳过 walletBalance≤0(DUST)、locked→Locked note。
describe("parseUnified (golden: fixture in → fixture out)", () => {
  const coins = walletBalance.result.list[0].coin;

  it("maps recorded UNIFIED coins to expected-unified-balances", () => {
    expect(parseUnified(coins)).toEqual(expected);
  });

  it("持有量取 walletBalance 而非 equity —— 合约浮盈不混进现货(ADR 0032)", () => {
    // BTC:walletBalance=0.05(现金),equity=0.06(含 0.01 浮盈)。取 walletBalance → amount=0.05;
    // 误用 equity 会把没落袋的浮盈算成现货持有。
    const btc = parseUnified(coins).find((b) => b.symbol === "BTC");
    expect(btc).toMatchObject({ amount: 0.05, value: 3000 });
  });

  it("value 用 Bybit 自带 usdValue,price 反推;locked 的币挂 Locked note", () => {
    const rows = parseUnified(coins);
    expect(rows.find((b) => b.symbol === "USD1")?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "80,000 USD1 · 100%",
    });
    expect(rows.find((b) => b.symbol === "USDT")?.note).toBeUndefined();
  });

  it("跳过 walletBalance≤0 的尘埃(DUST)", () => {
    expect(parseUnified(coins).some((b) => b.symbol === "DUST")).toBe(false);
  });
});

describe("bybitProvider.fetchBalances", () => {
  it("signs with X-BAPI headers (hex SIGN) and parses UNIFIED balances", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(walletBalance));
    const { balances } = await bybitProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["USD1", "USDT", "BTC"]);

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/v5/account/wallet-balance?accountType=UNIFIED");
    const h = init?.headers as Record<string, string>;
    expect(h["X-BAPI-API-KEY"]).toBe("k");
    expect(h["X-BAPI-RECV-WINDOW"]).toBe("5000");
    expect(h["X-BAPI-SIGN-TYPE"]).toBe("2");
    expect(h["X-BAPI-TIMESTAMP"]).toMatch(/^\d{13}$/); // ms epoch
    expect(h["X-BAPI-SIGN"]).toMatch(/^[a-f0-9]{64}$/); // hex HMAC-SHA256
  });

  it("maps HTTP-200 + auth retCode → AUTH_FAILED (Bybit error model)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ retCode: 10003, retMsg: "API key is invalid" }),
    );
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps HTTP-200 + non-auth retCode → UPSTREAM_ERROR; 429 → RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ retCode: 10001, retMsg: "param error" }));
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("serves connectorId bybit;PC 仅声明 BYBIT_API_BASE 覆盖 key(env 注入用,非账户凭据)", () => {
    expect(bybitProvider.id).toBe("bybit");
    expect(bybitProvider.creds.map((f) => f.key)).toEqual(["BYBIT_API_BASE"]);
    expect(bybitProvider.creds[0]?.type).toBe("public");
  });

  // #264:出口 IP 被地区封时,app 从 env 把代理 base 注入 ctx.creds.BYBIT_API_BASE。connector 只当不透明整串用。
  it("ctx.creds 设 BYBIT_API_BASE → 签名请求打覆盖 base,不打默认 api.bybit.com", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(walletBalance));
    await bybitProvider.fetchBalances(ctx(CREDS, { BYBIT_API_BASE: "https://px.example/s/bybit" }));
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("https://px.example/s/bybit/v5/account/wallet-balance");
    expect(url).not.toContain("api.bybit.com");
  });
});

// 契约(#240):凭据被拒 → false;够不到上游 → 抛 ProviderError,让调用方重试。
describe("bybitProvider.validateAccount", () => {
  it("true on retCode 0; false on auth retCode (creds pre-validated upstream)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(walletBalance));
    expect(await bybitProvider.validateAccount(ctx())).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ retCode: 10003, retMsg: "API key is invalid" }),
    );
    expect(await bybitProvider.validateAccount(ctx())).toBe(false);
  });
});
