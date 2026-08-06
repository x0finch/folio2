import { Fetcher, RateLimitScopeOverride, type UpstreamError } from "@folio/client-core";
import { Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { type CoinGeckoClientApi, type CoinGeckoConfig, make } from "../src/client";
import { CG_BASE_FREE, CG_BASE_PRO, HEADER_DEMO, HEADER_PRO, USER_AGENT } from "../src/constants";

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

const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: CoinGeckoClientApi) => Effect.Effect<A, E>,
  config: CoinGeckoConfig = {},
): Promise<A> =>
  Effect.gen(function* () {
    const client = yield* make(config);
    return yield* use(client);
  }).pipe(
    Effect.scoped,
    // 出网与闸的档位都是**服务**,不是 config 上的字段。
    Effect.provideService(Fetcher, fn),
    Effect.provideService(RateLimitScopeOverride, "memory"),
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: CoinGeckoClientApi) => Effect.Effect<unknown, UpstreamError>,
  config: CoinGeckoConfig = {},
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)), config);

describe("档位:key 决定 base、头和额度", () => {
  it("没 key → 免费 base,不带 key 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect(`${calls[0].url.origin}/api/v3`).toBe(CG_BASE_FREE);
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h[HEADER_DEMO]).toBeUndefined();
    expect(h[HEADER_PRO]).toBeUndefined();
  });

  it("有 key → demo 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1" });
    expect((calls[0].init?.headers as Record<string, string>)[HEADER_DEMO]).toBe("k1");
  });

  it("pro → pro base + pro 头", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { apiKey: "k1", pro: true });
    expect(`${calls[0].url.origin}/api/v3`).toBe(CG_BASE_PRO);
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h[HEADER_PRO]).toBe("k1");
    expect(h[HEADER_DEMO]).toBeUndefined();
  });

  it("**必须带 User-Agent**(CGK 的 WAF 对无 UA 请求返 403,Workers 默认不带)", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms);
    expect((calls[0].init?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("baseUrl 可覆盖", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.assetPlatforms, { baseUrl: "http://localhost:3099/cg" });
    expect(calls[0].url.href).toContain("/cg/asset_platforms");
  });
});

describe("端点", () => {
  it("coinsList 带 include_platform", async () => {
    const { fn, calls } = stub(() => json([{ id: "bitcoin" }]));
    const rows = await withClient(fn, (c) => c.coinsList);
    expect(calls[0].url.pathname).toBe("/api/v3/coins/list");
    expect(calls[0].url.searchParams.get("include_platform")).toBe("true");
    expect(rows).toEqual([{ id: "bitcoin" }]);
  });

  it("coinsMarkets:数组参数拼成逗号串,undefined 的键不参与", async () => {
    const { fn, calls } = stub(() => json([]));
    await withClient(fn, (c) => c.coinsMarkets({ vsCurrency: "usd", ids: ["btc", "eth"] }));
    expect(calls[0].url.searchParams.get("vs_currency")).toBe("usd");
    expect(calls[0].url.searchParams.get("ids")).toBe("btc,eth");
    // 没传的那些不该出现在 URL 里。
    expect(calls[0].url.searchParams.has("order")).toBe(false);
    expect(calls[0].url.searchParams.has("page")).toBe(false);
  });

  it("simplePrice:布尔开关**不传就是不传**,不是 false", async () => {
    // 传 "false" 与不传对 CGK 不是一回事。
    const { fn, calls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(fn, (c) => c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"] }));
    expect(calls[0].url.searchParams.has("include_24hr_change")).toBe(false);

    const { fn: on, calls: onCalls } = stub(() => json({ bitcoin: { usd: 1 } }));
    await withClient(on, (c) =>
      c.simplePrice({ ids: ["bitcoin"], vsCurrencies: ["usd"], include24hrChange: true }),
    );
    expect(onCalls[0].url.searchParams.get("include_24hr_change")).toBe("true");
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
    expect(calls[0].url.pathname).toBe("/api/v3/coins/bitcoin/market_chart/range");
  });

  it("coinContract:地址小写化,查不到 → null(不是失败)", async () => {
    const { fn, calls } = stub(() => json({}, { status: 404 }));
    const out = await withClient(fn, (c) => c.coinContract("ethereum", "0xAbCdEf"));
    expect(out).toBeNull();
    expect(calls[0].url.pathname).toBe("/api/v3/coins/ethereum/contract/0xabcdef");
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
    Effect.gen(function* () {
      const { fn } = stub(() => json([]));
      const client = yield* make(config);
      const fiber = yield* Effect.fork(
        Effect.all([
          Effect.orDie(client.assetPlatforms),
          Effect.orDie(client.assetPlatforms),
          Effect.orDie(client.assetPlatforms),
        ]).pipe(Effect.provideService(Fetcher, fn)),
      );
      yield* TestClock.adjust(Duration.millis(ms));
      // 假 fetch 是 `Promise.resolve`,不归 TestClock 管 —— 让出几轮微任务把它跑干净。
      yield* Effect.repeatN(Effect.yieldNow(), 50);
      return Option.isSome(yield* Fiber.poll(fiber));
    }).pipe(
      Effect.scoped,
      Effect.provideService(RateLimitScopeOverride, "memory"),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
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
    expect(calls[0].url.href).not.toContain("s3cr3t-key");
  });
});
