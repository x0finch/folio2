import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import type { ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bybitProvider } from "../../../src/connectors/bybit/provider";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import funding from "./fixtures/funding.json";
import wallet from "./fixtures/wallet-balance.json";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const okEmpty = () => json({ retCode: 0, result: { list: [] } });

// 按 pathname + query 分派(赚币两个类目共用一条路径,靠 `category` 区分)。
function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const { pathname, searchParams } = request.url;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (fragment.startsWith("category=")) {
        if (searchParams.get("category") === fragment.slice("category=".length)) return reply();
      } else if (pathname.includes(fragment)) {
        return reply();
      }
    }
    if (pathname.includes("/v5/earn/position")) {
      return json(searchParams.get("category") === "OnChain" ? earnOnchain : earnFlexible);
    }
    if (pathname.includes("/query-account-coins-balance")) return json(funding);
    return json(wallet); // /v5/account/wallet-balance
  });
}

type Ctx = Parameters<typeof bybitProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s" };
const ctx = (creds: Record<string, string> = CREDS, providerCreds: Record<string, string> = {}) =>
  ({
    account: { id: "a1", label: "Bybit", connectorId: "bybit", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("并发全桶(统一 / 资金 / 赚币)→ 合并 spot;赚币按类目标 note.group", async () => {
    const stub = upstream();
    const { balances } = await run(stub, bybitProvider.fetchBalances(ctx()));

    expect(balances.length).toBeGreaterThan(0);
    expect(balances.some((b) => b.note?.group === "funding")).toBe(true);
    expect(balances.some((b) => b.note?.group === "earn")).toBe(true);
    // 四个桶各打一发。
    expect(stub.calls).toHaveLength(4);
  });

  it("X-BAPI 签名头都带上", async () => {
    const stub = upstream();
    await run(stub, bybitProvider.fetchBalances(ctx()));
    const headers = stub.calls[0].request.headers;
    expect(headers["x-bapi-api-key"]).toBe("k");
    expect(headers["x-bapi-sign"]).toBeTruthy();
    expect(headers["x-bapi-timestamp"]).toBeTruthy();
  });

  it("部分桶失败(资金账户超时)→ 其余照返回 + 账户级 Note;整次同步成功", async () => {
    const stub = upstream({ "/query-account-coins-balance": () => json({}, { status: 504 }) });
    const { balances, note } = await run(stub, bybitProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.note?.group === "funding")).toBe(false);
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("next time"); // 瞬时故障 → 「下次补上」
  });

  it("auth 类失败(HTTP 200 + retCode 10005)→ 失败 Note 提示查权限", async () => {
    const stub = upstream({
      "/query-account-coins-balance": () => json({ retCode: 10005, retMsg: "permission denied" }),
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("**所有桶失败(429 打光所有端点)→ 失败**,不拿空快照覆盖", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, bybitProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });

  it("统一账户 totalPerpUPL 非零 → 挂「合约浮盈暂未纳入」兜底 Note", async () => {
    const stub = upstream({
      "/v5/account/wallet-balance": () =>
        json({ retCode: 0, result: { list: [{ coin: [], totalPerpUPL: "123.45" }] } }),
      "/query-account-coins-balance": okEmpty,
      "/v5/earn/position": okEmpty,
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBe(true);
  });

  it("无合约浮盈(totalPerpUPL 缺失 / 0)→ 不虚报", async () => {
    const stub = upstream({
      "/v5/account/wallet-balance": () =>
        json({ retCode: 0, result: { list: [{ coin: [], totalPerpUPL: "0" }] } }),
      "/query-account-coins-balance": okEmpty,
      "/v5/earn/position": okEmpty,
    });
    const { note } = await run(stub, bybitProvider.fetchBalances(ctx()));
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("PC 只声明一个 base URL 覆盖 key", () => {
    expect(bybitProvider.id).toBe("bybit");
    expect(bybitProvider.creds.map((f) => f.key)).toEqual(["BYBIT_API_BASE"]);
    expect(bybitProvider.creds.every((f) => f.type === "public")).toBe(true);
  });

  it("base 覆盖生效,默认 host 一个不留", async () => {
    const stub = upstream();
    await run(
      stub,
      bybitProvider.fetchBalances(ctx(CREDS, { BYBIT_API_BASE: "https://px.example/bybit" })),
    );
    const urls = stub.calls.map((c) => c.request.url.href);
    expect(urls.every((u) => u.startsWith("https://px.example/bybit"))).toBe(true);
    expect(urls.some((u) => u.includes("bybit.com"))).toBe(false);
  });
});

describe("validateAccount", () => {
  it("retCode 0 → true", async () => {
    const stub = httpStub(() => json(wallet));
    expect(await run(stub, bybitProvider.validateAccount(ctx()))).toBe(true);
  });

  it("凭据被拒(HTTP 200 + retCode 10003)→ false,不进错误通道", async () => {
    const stub = httpStub(() => json({ retCode: 10003, retMsg: "API key is invalid" }));
    expect(await run(stub, bybitProvider.validateAccount(ctx()))).toBe(false);
  });

  it("非凭据 retCode → 走错误通道,不压成 false", async () => {
    const stub = httpStub(() => json({ retCode: 10016, retMsg: "server error" }));
    expect((await failing(stub, bybitProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorUnavailableError",
    );
  });

  it("429 → 限流(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, bybitProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });
});
