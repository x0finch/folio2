import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Duration, Effect, Fiber, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import {
  CoinGeckoClient,
  type CoinGeckoClientApi,
  type CoinGeckoConfig,
  make,
} from "../src/client";
import { CG_BASE_FREE, CG_BASE_PRO, HEADER_DEMO, HEADER_PRO, USER_AGENT } from "../src/constants";

// 假出网:记下每一发。顶替的是 **`HttpClient` 服务**而不是 `globalThis.fetch` ——
// 请求层底下是官方客户端,在那一层顶替才测得到真实路径(签名头、method、body 都经过它)。
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

const withClient = <A, E>(
  fn: HttpStub,
  use: (client: CoinGeckoClientApi) => Effect.Effect<A, E, Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> =>
  // `runClient` 装的是「假出网 + `memory` 档限频 + TestClock」——**九个包共用一份**
  // (以前是九份手抄的,有几份漏了限频档,于是偷偷跑在了模块级共享游标的那一档上)。
  runClient(
    fn,
    Effect.gen(function* () {
      const client = yield* make(config);
      return yield* use(client);
    }),
  );

const failing = (
  fn: HttpStub,
  use: (c: CoinGeckoClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
  config: CoinGeckoConfig = {},
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)), config);

describe("档位:key 决定 base、头和额度", () => {
  it("没 key → 免费 base,不带 key 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect(`${calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_FREE);
    const h = calls[0].request.headers;
    expect(h[HEADER_DEMO]).toBeUndefined();
    expect(h[HEADER_PRO]).toBeUndefined();
  });

  it("有 key → demo 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1" });
    expect(calls[0].request.headers[HEADER_DEMO]).toBe("k1");
  });

  it("pro → pro base + pro 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1", pro: true });
    expect(`${calls[0].request.url.origin}/api/v3`).toBe(CG_BASE_PRO);
    const h = calls[0].request.headers;
    expect(h[HEADER_PRO]).toBe("k1");
    expect(h[HEADER_DEMO]).toBeUndefined();
  });

  it("**必须带 User-Agent**(CGK 的 WAF 对无 UA 请求返 403,Workers 默认不带)", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect(calls[0].request.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("baseUrl 可覆盖", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { baseUrl: "http://localhost:3099/cg" });
    expect(calls[0].request.url.href).toContain("/cg/asset_platforms");
  });
});

describe("端点", () => {
  it("coinsList 带 include_platform", async () => {
    const { fn, calls } = stub(() => json([{ id: "bitcoin" }]));
    const rows = await withClient(fn, (c) => c.coinsList);
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/list");
    expect(calls[0].request.url.searchParams.get("include_platform")).toBe("true");
    expect(rows).toEqual([{ id: "bitcoin" }]);
  });

  it("coinsMarkets:数组参数拼成逗号串,undefined 的键不参与", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.coinsMarkets({ vsCurrency: "usd", ids: ["btc", "eth"] }));
    expect(calls[0].request.url.searchParams.get("vs_currency")).toBe("usd");
    expect(calls[0].request.url.searchParams.get("ids")).toBe("btc,eth");
    // 没传的那些不该出现在 URL 里。
    expect(calls[0].request.url.searchParams.has("order")).toBe(false);
    expect(calls[0].request.url.searchParams.has("page")).toBe(false);
  });

  it("simplePrice:布尔开关**不传就是不传**,不是 false", async () => {
    // 传 "false" 与不传对 CGK 不是一回事。
    const { fn, calls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(fn, (c) => c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"] }));
    expect(calls[0].request.url.searchParams.has("include_24hr_change")).toBe(false);

    const { fn: on, calls: onCalls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(on, (c) =>
      c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"], include24hrChange: true }),
    );
    expect(onCalls[0].request.url.searchParams.get("include_24hr_change")).toBe("true");
  });

  it("coinsMarketChartRange:出口就是 prices 那一列", async () => {
    // 上游把它包在一个对象里,那层包装没有信息。
    const { fn, calls } = stub(() =>
      json({ prices: [[1, 2]], market_caps: [], total_volumes: [] }),
    );
    const prices = await withClient(fn, (c) =>
      c.coinsMarketChartRange({ id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(prices).toEqual([[1, 2]]);
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  });

  it("coinContract:地址小写化,查不到 → null(不是失败)", async () => {
    const { fn, calls } = stub(() => json({}, { status: 404 }));
    const out = await withClient(fn, (c) => c.coinContract("ethereum", "0xAbCdEf"));
    expect(out).toBeNull();
    expect(calls[0].request.url.pathname).toBe("/api/v3/coins/ethereum/contract/0xabcdef");
  });

  it("exchange / derivativesExchange 查不到也 → null", async () => {
    const { fn } = stub(() => json({}, { status: 404 }));
    expect(await withClient(fn, (c) => c.exchange("nope"))).toBeNull();
    expect(await withClient(fn, (c) => c.derivativesExchange("nope"))).toBeNull();
  });
});

describe("顶层形状守卫", () => {
  // 没有它,返回类型就是在撒谎:下游拿着一个错误页当数组遍历。
  // 这不是完整校验(字段一个没查)—— 那是 `Effect.Schema` 那一步的事。
  it("列表端点回的不是数组 → parse", async () => {
    const { fn } = stub(() => json({ error: "rate limited" }));
    const err = await failing(fn, (c) => c.coinsList);
    expect(err._tag).toBe("UpstreamParseError");
    expect(err.where).toBe("/coins/list");
  });

  it("对象端点回的不是对象 → parse", async () => {
    const { fn } = stub(() => json("nope"));
    expect((await failing(fn, (c) => c.exchangeRates))._tag).toBe("UpstreamParseError");
  });

  it("market_chart/range 少了 prices → parse", async () => {
    const { fn } = stub(() => json({ market_caps: [] }));
    const err = await failing(fn, (c) =>
      c.coinsMarketChartRange({ id: "bitcoin", vsCurrency: "usd", fromSec: 1, toSec: 2 }),
    );
    expect(err._tag).toBe("UpstreamParseError");
  });
});

describe("限频", () => {
  // **CGK 最需要闸**:一把 key 全部署共用,所有用户的每次调用都花同一份额度。
  //
  // 官方 token-bucket 每 `interval / limit` 补一个令牌。
  // keyless 档 10 次/分钟、容量 2 → interval 12s → 每 **6** 秒补一个,前 2 发满额突发、第 3 发等 6 秒。
  const settledAfter = (ms: number, config: CoinGeckoConfig = {}) =>
    runClient(
      stub(() => json([])).fn,
      Effect.gen(function* () {
        const client = yield* make(config);
        const fiber = yield* Effect.fork(
          Effect.all([
            Effect.orDie(client.assetPlatforms),
            Effect.orDie(client.assetPlatforms),
            Effect.orDie(client.assetPlatforms),
          ]),
        );
        yield* TestClock.adjust(Duration.millis(ms));
        // 假出网是 `Promise.resolve`,不归 TestClock 管 —— 让出几轮微任务把它跑干净。
        yield* Effect.repeatN(Effect.yieldNow(), 50);
        return Option.isSome(yield* Fiber.poll(fiber));
      }),
    );

  it("超出突发的那一发要等", async () => {
    expect(await settledAfter(5_999)).toBe(false);
    expect(await settledAfter(6_000)).toBe(true);
  });

  it("有 key 的档位额度大得多(80/分钟 → 第 3 发只等 750ms,不是 6 秒)", async () => {
    expect(await settledAfter(749, { apiKey: "k1" })).toBe(false);
    expect(await settledAfter(750, { apiKey: "k1" })).toBe(true);
  });
});

describe("错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ status: { error_message: "nope" } }, init));
    return failing(fn, (c) => c.assetPlatforms);
  };

  it("429 → 限流,带上 Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "9" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(9000);
  });

  it("401 / 403 → 凭据问题", async () => {
    // **与老版不同**:老版把它们归成 UPSTREAM_ERROR(理由是 CGK 没有独立的「凭据被拒」语义)。
    // 共享归类叫它凭据问题 —— 更准,而且实际重试行为不变(老版按 status>=500 判可重试,
    // 401/403 本来也不重试)。
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("5xx / 出不去 → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
    const { fn } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(fn, (c) => c.assetPlatforms))._tag).toBe("UpstreamUnavailableError");
  });

  it("失败信息带 upstream、只带 pathname", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("coingecko");
    expect(err.where).toBe("/api/v3/asset_platforms");
  });

  it("key 不进 URL(它走头)", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "s3cr3t-key" });
    expect(calls[0].request.url.href).not.toContain("s3cr3t-key");
  });
});

// **走 Tag / Layer 那一条路。** 生产只走它,而在这之前**九个包的测试一条都没走过** ——
// 全部直接调 `make`,于是「`layer()` 装出来的东西和 `make` 是不是同一个」从来没人验证。
// 这是复审点出来的真空档(#12)。
describe("装配:Tag 路径", () => {
  it("`CoinGeckoClient.layer(...)` 装出来的就是 `make` 那个 client", async () => {
    const { fn, calls } = stub(() => json([]));
    const out = await runClient(
      fn,
      Effect.flatMap(CoinGeckoClient, (client) => client.assetPlatforms).pipe(
        Effect.provide(CoinGeckoClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
