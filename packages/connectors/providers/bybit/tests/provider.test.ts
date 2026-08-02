import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPriceHint, bybitProvider, parseEarn, parseFunding, parseUnified } from "../src";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import expectedFlexEarn from "./fixtures/expected-flexible-earn.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedOnchainEarn from "./fixtures/expected-onchain-earn.json";
import expected from "./fixtures/expected-unified-balances.json";
import funding from "./fixtures/funding.json";
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

// 资金账户(FUND)golden:funding.json(录制的 /asset/transfer/query-account-coins-balance 响应)+
// 统一账户市价提示表 → expected-funding-balances.json。覆盖:walletBalance→amount、稳定币≈1(USDT)、
// 统一账户市价复用(BTC)、无价的币 value 0 交 oracle(WLFI)、每条带 note.group:"funding"。
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(walletBalance.result.list[0].coin);
    expect(parseFunding(funding.result.balance, hint)).toEqual(expectedFunding);
  });

  it("每条 funding 余额带不渲染的 note.group='funding'(供抽屉归 Tab)", () => {
    const hint = buildPriceHint(walletBalance.result.list[0].coin);
    expect(
      parseFunding(funding.result.balance, hint).every((r) => r.note?.group === "funding"),
    ).toBe(true);
  });
});

// 赚币(earn)golden:earn-flexible/onchain.json + 统一账户市价提示表 → 期望值。覆盖:amount→amount、
// 类目标签(Flexible / On-chain)、note.group:"earn"、价复用统一账户市价(BTC)/稳定币(USDT)、
// 跳过 amount≤0(已赎回残值)。**不标 APY**(Bybit 持仓端点无 APR,ADR 0032)。
describe("parseEarn (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(walletBalance.result.list[0].coin);
  it("flexible: amount→amount, 类目 note content='Flexible', group earn;跳过 amount=0", () => {
    expect(parseEarn(earnFlexible.result.list, "Flexible", hint)).toEqual(expectedFlexEarn);
  });
  it("on-chain: 类目 note content='On-chain', group earn", () => {
    expect(parseEarn(earnOnchain.result.list, "On-chain", hint)).toEqual(expectedOnchainEarn);
  });
});

describe("bybitProvider.fetchBalances", () => {
  // 所有端点的路由 mock;不匹配的返回统一账户 walletBalance。
  const routeAll = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("query-account-coins-balance")) return ok(funding);
      if (u.includes("/v5/earn/position") && u.includes("FlexibleSaving")) return ok(earnFlexible);
      if (u.includes("/v5/earn/position") && u.includes("OnChain")) return ok(earnOnchain);
      return ok(walletBalance);
    });

  it("并发全桶(统一/资金/赚币)→ 合并 spot;赚币按类目标 note.group='earn'", async () => {
    routeAll();
    const { balances } = await bybitProvider.fetchBalances(ctx());
    // 统一 3 + 资金 3 + 赚币 2(Flexible USDT + OnChain BTC)= 8
    expect(balances).toHaveLength(8);
    const earn = balances.filter((b) => b.note?.group === "earn");
    expect(earn.map((b) => b.symbol)).toEqual(["USDT", "BTC"]);
    expect(earn.map((b) => b.note?.content)).toEqual(["Flexible", "On-chain"]);
  });

  // —— 片 4:尽力而为 + perp 兜底 ——
  it("部分桶失败(资金账户超时)→ 其余照返回 + 账户级失败 Note;整次同步成功", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("query-account-coins-balance")) return new Response("", { status: 504 });
      if (u.includes("/v5/earn/position")) return ok({ retCode: 0, result: { list: [] } });
      return ok(walletBalance);
    });
    const { balances, note } = await bybitProvider.fetchBalances(ctx());
    // 统一账户 3 成功;资金失败 → 无 funding 行,但不抛。
    expect(balances).toHaveLength(3);
    expect(balances.some((b) => b.note?.group === "funding")).toBe(false);
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("next time"); // 瞬时故障 → "下次补上"
  });

  it("auth 类失败(权限不足)→ 失败 Note 提示查权限", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      // 赚币端点返回权限类错误码(HTTP 200 + 10005 permission denied)。
      if (u.includes("/v5/earn/position"))
        return ok({ retCode: 10005, retMsg: "permission denied" });
      if (u.includes("query-account-coins-balance"))
        return ok({ retCode: 0, result: { balance: [] } });
      return ok(walletBalance);
    });
    const { note } = await bybitProvider.fetchBalances(ctx());
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Earn");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("所有桶失败(429 限流所有端点)→ 抛,不拿空快照覆盖", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("统一账户 totalPerpUPL 非零 → 挂'合约浮盈暂未纳入'perp 兜底 Note", async () => {
    // walletBalance 变体:account 带 totalPerpUPL(有合约浮盈被排除在 walletBalance 外)。
    const withUpl = {
      retCode: 0,
      result: { list: [{ accountType: "UNIFIED", totalPerpUPL: "123.45", coin: [] }] },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("query-account-coins-balance"))
        return ok({ retCode: 0, result: { balance: [] } });
      if (u.includes("/v5/earn/position")) return ok({ retCode: 0, result: { list: [] } });
      return ok(withUpl);
    });
    const { note } = await bybitProvider.fetchBalances(ctx());
    const perp = note?.find((n) => n.title === "Futures positions detected");
    expect(String(perp?.content)).toContain("+$123.45");
  });

  it("无合约浮盈(totalPerpUPL 缺失/0)→ 不挂 perp Note(不虚报)", async () => {
    // wallet-balance fixture 无 totalPerpUPL → 视为 0 → 不报。
    routeAll();
    const { note } = await bybitProvider.fetchBalances(ctx());
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("signs with X-BAPI headers (hex SIGN) and parses UNIFIED balances", async () => {
    // 本测聚焦统一账户签名/解析;funding + earn 端点返回空,合并与并发另见专测。
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("query-account-coins-balance"))
        return ok({ retCode: 0, result: { balance: [] } });
      if (u.includes("/v5/earn/position")) return ok({ retCode: 0, result: { list: [] } });
      return ok(walletBalance);
    });
    const { balances } = await bybitProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["USD1", "USDT", "BTC"]);

    // 并发多端点:哪个请求先 fetch 由异步 HMAC 签名的完成顺序定,calls[0] 不保证是统一账户 → 用 find 定位。
    const call = spy.mock.calls.find((c) => String(c[0]).includes("/v5/account/wallet-balance"));
    const init = call?.[1];
    expect(String(call?.[0])).toContain("/v5/account/wallet-balance?accountType=UNIFIED");
    const h = init?.headers as Record<string, string>;
    expect(h["X-BAPI-API-KEY"]).toBe("k");
    expect(h["X-BAPI-RECV-WINDOW"]).toBe("5000");
    expect(h["X-BAPI-SIGN-TYPE"]).toBe("2");
    expect(h["X-BAPI-TIMESTAMP"]).toMatch(/^\d{13}$/); // ms epoch
    expect(h["X-BAPI-SIGN"]).toMatch(/^[a-f0-9]{64}$/); // hex HMAC-SHA256
  });

  it("并发打统一账户 + 资金账户,两端点均被签名调用,合并出一份余额", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("query-account-coins-balance")) return ok(funding);
      return ok(walletBalance);
    });
    const { balances } = await bybitProvider.fetchBalances(ctx());
    // 统一账户 3(USD1/USDT/BTC)+ 资金账户 3(USDT/BTC/WLFI)= 6,不同桶同名币各自成行(聚合层按 token_id 合并)。
    expect(balances.map((b) => b.symbol)).toEqual(["USD1", "USDT", "BTC", "USDT", "BTC", "WLFI"]);
    expect(balances.filter((b) => b.note?.group === "funding")).toHaveLength(3);

    const paths = spy.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.includes("/v5/account/wallet-balance"))).toBe(true);
    expect(paths.some((p) => p.includes("query-account-coins-balance"))).toBe(true);
    for (const [, init] of spy.mock.calls) {
      const h = init?.headers as Record<string, string>;
      expect(h["X-BAPI-API-KEY"]).toBe("k");
      expect(h["X-BAPI-SIGN"]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  // fetchBalances 现并发打多个端点(每次 fetch 需**独立** Response —— body 只能读一次,共享同一个
  // Response 对象会「Body already read」),故错误 mock 用 mockImplementation 每调用返回新 Response。
  it("maps HTTP-200 + auth retCode → AUTH_FAILED (Bybit error model)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ok({ retCode: 10003, retMsg: "API key is invalid" }),
    );
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps HTTP-200 + non-auth retCode → UPSTREAM_ERROR; 429 → RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ok({ retCode: 10001, retMsg: "param error" }),
    );
    await expect(bybitProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
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
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("query-account-coins-balance"))
        return ok({ retCode: 0, result: { balance: [] } });
      return ok(walletBalance);
    });
    await bybitProvider.fetchBalances(ctx(CREDS, { BYBIT_API_BASE: "https://px.example/s/bybit" }));
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(
      urls.some((u) => u.startsWith("https://px.example/s/bybit/v5/account/wallet-balance")),
    ).toBe(true);
    expect(urls.some((u) => u.startsWith("https://px.example/s/bybit/v5/asset/transfer"))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes("api.bybit.com"))).toBe(false);
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
