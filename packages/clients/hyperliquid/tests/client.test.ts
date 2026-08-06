import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  HyperliquidClient,
  type HyperliquidClientApi,
  type HyperliquidConfig,
  make,
} from "../src/client";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE } from "../src/constants";
import stateFixture from "./fixtures/clearinghouse-state.json" with { type: "json" };

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 假出网:记下每一发。顶替的是 **`HttpClient` 服务**而不是 `globalThis.fetch` ——
// 请求层底下是官方客户端,在那一层顶替才测得到真实路径(签名头、method、body 都经过它)。
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// **构造是纯的**(没有闸就没有 Scope),所以这里不用在 Effect 里建 client —— 与 binance 的
// `withClient` 不同,那边 `make` 返回 Effect。别为了形状统一而假装需要 Scope。
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: HyperliquidClientApi) => Effect.Effect<A, E, Outbound>,
  config: HyperliquidConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: HyperliquidClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("clearinghouseState", () => {
  it("POST /info,body 里带 type 与 user", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));

    expect(calls[0].request.url.origin).toBe(HYPERLIQUID_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/info");
    expect(calls[0].request.method).toBe("POST");
    expect(JSON.parse(String(calls[0].request.body))).toEqual({
      type: CLEARINGHOUSE_TYPE,
      user: ADDR,
    });
  });

  it("带上 content-type: application/json(少了它上游回 422)", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR));
    expect(calls[0].request.headers["content-type"]).toBe("application/json");
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
    expect(JSON.parse(String(calls[0].request.body)).user).toBe(ADDR);
    expect(JSON.parse(String(calls[1].request.body)).user).toBe(other);
  });

  it("apiBase 可覆盖,且当不透明整串用", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    await withClient(fn, (c) => c.clearinghouseState(ADDR), {
      apiBase: "http://localhost:3099/hl-proxy",
    });
    expect(calls[0].request.url.href).toContain("/hl-proxy/info");
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

// **走 Tag / Layer 那一条路。** 生产只走它,而在这之前**九个包的测试一条都没走过** ——
// 全部直接调 `make`,于是「`layer()` 装出来的东西和 `make` 是不是同一个」从来没人验证。
// 这是复审点出来的真空档(#12)。
describe("装配:Tag 路径", () => {
  it("`HyperliquidClient.layer(...)` 装出来的就是 `make` 那个 client", async () => {
    const { fn, calls } = stub(() => json(stateFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(HyperliquidClient, (client) => client.clearinghouseState(ADDR)).pipe(
        Effect.provide(HyperliquidClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
