import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { okxProvider } from "../../../src/connectors/okx/provider";
import balance from "./fixtures/balance.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";
import valuation from "./fixtures/valuation.json";

// 打桩打在 `HttpClient` 服务上,不再是 `globalThis.fetch` —— 那才是生产走的路。
const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const empty = () => json({ code: "0", data: [] });

// 按 pathname 分派。没给的桶默认空,不匹配的落到交易账户 —— 每个用例只写它关心的那几个。
function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/api/v5/asset/balances")) return json(funding);
    if (path.includes("/finance/savings/balance")) return json(savings);
    if (path.includes("/finance/staking-defi/orders-active")) return json(staking);
    if (path.includes("/asset/asset-valuation")) return json(valuation);
    if (path.includes("/api/v5/account/positions")) return empty();
    return json(balance); // /api/v5/account/balance
  });
}

type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s", passphrase: "p" };
const ctx = (creds: Record<string, string> = CREDS, providerCreds: Record<string, string> = {}) =>
  ({
    account: { id: "a1", label: "OKX", connectorId: "okx", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("并发全桶(交易 / 资金 / 赚币)→ 合并 spot;earn 残差合成行计进净值", async () => {
    const stub = upstream();
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances).toHaveLength(10); // 交易 4 + 资金 3 + 赚币 2 + earn 残差合成行 1
    const uncategorized = balances.find((b) => b.tokenRef === "okx/custom:EARN-UNCATEGORIZED");
    expect(uncategorized).toMatchObject({ value: 1000, kind: "spot" });
    expect(uncategorized?.note?.group).toBe("earn");
    expect(balances.filter((b) => b.note?.group === "earn")).toHaveLength(3);
    expect(note).toBeUndefined();
  });

  it("四个 OK-ACCESS 头都带上,现货解析对得上", async () => {
    const stub = upstream({ "/api/v5/asset/balances": empty });
    const { balances } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances.map((b) => b.symbol)).toContain("BTC");
    const headers = stub.calls[0].request.headers;
    expect(headers["ok-access-key"]).toBe("k");
    expect(headers["ok-access-sign"]).toBeTruthy();
    expect(headers["ok-access-timestamp"]).toBeTruthy();
    expect(headers["ok-access-passphrase"]).toBe("p");
  });

  it("asset-valuation 挂了 → 不阻断同步,只是本轮没残差", async () => {
    const stub = upstream({ "/asset/asset-valuation": () => json({}, { status: 500 }) });
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(balances).toHaveLength(9);
    expect(note).toBeUndefined();
  });

  it("部分桶失败(赚币没权限)→ 其余照返回 + 账户级 Note;整次同步成功", async () => {
    // **401 而不是 504**(FOL-31):瞬时故障现在会升级成整账户失败(见下一条),到不了 Note。
    // 尽力而为只留给「等也没用」的失败 —— 权限没勾,重试变不出权限来。
    const stub = upstream({
      "/finance/savings/balance": () => json({}, { status: 401 }),
      "/finance/staking-defi/orders-active": () => json({}, { status: 401 }),
      "/asset/asset-valuation": () => json({ code: "0", data: [{ details: { earn: "12000" } }] }),
    });
    const { balances, note } = await run(stub, okxProvider.fetchBalances(ctx()));

    expect(balances).toHaveLength(7); // 交易 4 + 资金 3
    expect(balances.some((b) => b.note?.group === "earn")).toBe(false);
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Savings");
    expect(String(failNote?.content)).toContain("Staking");
    expect(String(failNote?.content)).toContain("permissions");
    // earn 桶失败时**不产**未细分合成行:那 $12k 是没拉到、不是未细分,凭空计进净值会虚增。
    expect(balances.some((b) => b.tokenRef === "okx/custom:EARN-UNCATEGORIZED")).toBe(false);
  });

  // —— FOL-31:瞬时部分失败升级 ——
  it("**部分桶瞬时失败(交易桶 504)→ 整账户失败**进重试,不写残缺快照", async () => {
    // 交易桶通常是大头,降级写出去就是「资产掉一块」—— 与 binance 那次生产事故同一种症状。
    const stub = upstream({ "/account/balance": () => json({}, { status: 504 }) });
    const err = await failing(stub, okxProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("瞬时错混着权限错 → 仍整账户失败(瞬时那个才是重试的理由)", async () => {
    const stub = upstream({
      "/finance/savings/balance": () => json({}, { status: 401 }),
      "/asset/balances": () => json({}, { status: 429 }),
    });
    const err = await failing(stub, okxProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("auth 类失败(HTTP 200 + 50xxx)→ 失败 Note 提示查权限", async () => {
    const stub = upstream({
      "/api/v5/asset/balances": () => json({ code: "50111", msg: "Invalid Key" }),
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("**四个余额桶全失败(429 打光所有端点)→ 失败**,不拿空快照覆盖", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, okxProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });

  it("positions 非空 → 挂「合约浮盈暂未纳入」兜底 Note", async () => {
    const stub = upstream({
      "/api/v5/account/positions": () =>
        json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "1", upl: "123" }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBe(true);
  });

  it("positions 全是已平仓行(pos=0)→ 不虚报", async () => {
    const stub = upstream({
      "/api/v5/account/positions": () =>
        json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "0", upl: "0" }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
      "/asset/asset-valuation": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("四桶对账:classic 桶 > 0(folio 不拉)→ 挂「经典账户未同步」Note", async () => {
    const stub = upstream({
      "/asset/asset-valuation": () =>
        json({ code: "0", data: [{ details: { classic: "8888", earn: "0" } }] }),
      "/api/v5/asset/balances": empty,
      "/finance/": empty,
    });
    const { note } = await run(stub, okxProvider.fetchBalances(ctx()));
    expect(String(note?.find((n) => n.title === "Classic account not synced")?.content)).toContain(
      "$8,888",
    );
  });

  it("asset-valuation 必须带 ccy=USD(该端点默认 BTC 计价,不传就单位错位)", async () => {
    const stub = upstream();
    await run(stub, okxProvider.fetchBalances(ctx()));
    const valuationCall = stub.calls.find((c) =>
      c.request.url.pathname.includes("asset-valuation"),
    );
    expect(valuationCall?.request.url.searchParams.get("ccy")).toBe("USD");
  });

  it("PC 只声明一个 base URL 覆盖 key", () => {
    expect(okxProvider.id).toBe("okx");
    expect(okxProvider.creds.map((f) => f.key)).toEqual(["OKX_API_BASE"]);
    expect(okxProvider.creds.every((f) => f.type === "public")).toBe(true);
  });

  it("base 覆盖生效,默认 host 一个不留", async () => {
    const stub = upstream();
    await run(
      stub,
      okxProvider.fetchBalances(ctx(CREDS, { OKX_API_BASE: "https://px.example/okx" })),
    );
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/okx"))).toBe(true);
    expect(urls.some((u) => u.includes("okx.com"))).toBe(false);
  });
});

describe("validateAccount", () => {
  it("200 + code 0 → true", async () => {
    const stub = httpStub(() => json(balance));
    expect(await run(stub, okxProvider.validateAccount(ctx()))).toBe(true);
  });

  it("凭据被拒(HTTP 200 + 50111)→ false,不进错误通道", async () => {
    const stub = httpStub(() => json({ code: "50111", msg: "Invalid Key" }));
    expect(await run(stub, okxProvider.validateAccount(ctx()))).toBe(false);
  });

  it("非凭据码 → 走错误通道,不压成 false", async () => {
    const stub = httpStub(() => json({ code: "50011", msg: "rate limited" }));
    const err = await failing(stub, okxProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });

  it("429 → 限流(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, okxProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });
});
