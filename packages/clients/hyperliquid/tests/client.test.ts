import { Fetcher, type UpstreamError } from "@folio/client-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type HyperliquidClientApi, type HyperliquidConfig, make } from "../src/client";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE } from "../src/constants";
import stateFixture from "./fixtures/clearinghouse-state.json" with { type: "json" };

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

interface Seen {
  url: URL;
  init?: RequestInit;
}

function stub(reply: (url: URL) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(reply(url));
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

// **构造是纯的**(没有闸就没有 Scope),所以这里不用在 Effect 里建 client —— 与 binance 的
// `withClient` 不同,那边 `make` 返回 Effect。别为了形状统一而假装需要 Scope。
const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: HyperliquidClientApi) => Effect.Effect<A, E, Fetcher>,
  config: HyperliquidConfig = {},
): Promise<A> => Effect.runPromise(Effect.provideService(use(make(config)), Fetcher, fn));

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: HyperliquidClientApi) => Effect.Effect<unknown, UpstreamError, Fetcher>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("clearinghouseState", () => {
  it("POST /info,body 里带 type 与 user", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));

    expect(calls[0].url.origin).toBe(HYPERLIQUID_API_BASE);
    expect(calls[0].url.pathname).toBe("/info");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      type: CLEARINGHOUSE_TYPE,
      user: ADDR,
    });
  });

  it("带上 content-type: application/json(少了它上游回 422)", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    // client 的出口就是 DTO —— 数字仍是字符串,parse 归适配层(ADR 0036)。
    const { fn } = stub(() => json(stateFixture));
    const state = await withClient(fn, (c) => c.clearinghouseState(ADDR));
    expect(state).toEqual(stateFixture);
    expect(typeof state.marginSummary?.accountValue).toBe("string");
  });

  it("地址每次调用传,一个 client 服务多个账户", async () => {
    const other = "0x0000000000000000000000000000000000000001";
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) =>
      Effect.all([c.clearinghouseState(ADDR), c.clearinghouseState(other)]),
    );
    expect(JSON.parse(String(calls[0].init?.body)).user).toBe(ADDR);
    expect(JSON.parse(String(calls[1].init?.body)).user).toBe(other);
  });

  it("apiBase 可覆盖,且当不透明整串用", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR), {
      apiBase: "http://localhost:3099/hl-proxy",
    });
    expect(calls[0].url.href).toContain("/hl-proxy/info");
  });
});

describe("错误归类", () => {
  // **hyperliquid 没有归类差异**(info 端点无 auth,「凭据被拒」这条路不存在),
  // 这几条验的是 core 的默认规则在这条链路上确实通了。
  it("429 → 限流,带上 Retry-After", async () => {
    const { fn } = stub(() => json({}, { status: 429, headers: { "retry-after": "7" } }));
    const err = await failing(fn, (c) => c.clearinghouseState(ADDR));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
  });

  it("5xx / 出不去 → 够不到上游", async () => {
    const { fn: down } = stub(() => json({}, { status: 503 }));
    expect((await failing(down, (c) => c.clearinghouseState(ADDR)))._tag).toBe(
      "UpstreamUnavailableError",
    );
    const { fn: dead } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(dead, (c) => c.clearinghouseState(ADDR)))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.clearinghouseState(ADDR)))._tag).toBe("UpstreamParseError");
  });

  it("错误带 upstream,答「是谁失败的」", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.clearinghouseState(ADDR))).upstream).toBe("hyperliquid");
  });

  it("失败信息不带 query / 地址(原则 #5 红线)", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.clearinghouseState(ADDR));
    expect(err.where).toBe("/info");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});
