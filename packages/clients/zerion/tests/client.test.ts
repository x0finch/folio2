import { Fetcher, RateLimitScopeOverride, type UpstreamError } from "@folio/client-core";
import { Duration, Effect, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { make, type ZerionClientApi, type ZerionConfig } from "../src/client";
import { CHAINS_CACHE_TTL_MS, ZERION_API_BASE } from "../src/constants";
import chainsFixture from "./fixtures/chains.json" with { type: "json" };
import positionsFixture from "./fixtures/positions.json" with { type: "json" };

const KEY = "the-api-key";
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

// 链映射缓存**按 baseUrl 分桶**(见 chains-cache.ts)—— 所以每个用例给自己一个 base 就天然隔离,
// 不需要 resetForTests 这种全局开关。默认 base 留给「不碰缓存」的用例。
let bases = 0;
const freshBase = () => `https://zerion-${bases++}.test`;

const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: ZerionClientApi) => Effect.Effect<A, E>,
  over: Partial<ZerionConfig> = {},
): Promise<A> =>
  Effect.gen(function* () {
    const client = yield* make({ apiBase: freshBase(), ...over });
    return yield* use(client);
  }).pipe(
    Effect.scoped,
    Effect.provideService(Fetcher, fn),
    Effect.provideService(RateLimitScopeOverride, "memory"),
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: ZerionClientApi) => Effect.Effect<unknown, UpstreamError>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

// chains 与 positions 按路径分流。
const bothEndpoints = (opts: { chains?: () => Response; positions?: () => Response } = {}) =>
  stub((url) =>
    url.pathname.includes("/chains")
      ? (opts.chains?.() ?? json(chainsFixture))
      : (opts.positions?.() ?? json(positionsFixture)),
  );

describe("认证", () => {
  it("HTTP Basic:key 作 username、密码空,走头不走 query", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa(`${KEY}:`)}`);
    // 解回来确认密码位是空的 —— 写错成 `key:key` 上游也认,但那是把 key 多暴露了一次。
    expect(atob(auth.slice("Basic ".length))).toBe(`${KEY}:`);
    expect(calls[0].url.searchParams.has("apiKey")).toBe(false);
  });
});

describe("positions", () => {
  it("打对路径,带上三个 filter(少了 no_filter 就一条 DeFi 都拿不到)", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }), {
      apiBase: ZERION_API_BASE,
    });
    expect(calls[0].url.origin).toBe(ZERION_API_BASE);
    expect(calls[0].url.pathname).toBe(`/v1/wallets/${ADDR}/positions/`);
    // 默认是 only_simple,会把全部协议头寸剔掉 —— 这条 query 是 DeFi 行存在的前提。
    expect(calls[0].url.searchParams.get("filter[positions]")).toBe("no_filter");
    expect(calls[0].url.searchParams.get("filter[trash]")).toBe("only_non_trash");
    expect(calls[0].url.searchParams.get("currency")).toBe("usd");
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    const { fn } = bothEndpoints();
    const res = await withClient(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));
    expect(res).toEqual(positionsFixture);
  });
});

describe("chainIds", () => {
  it("hex external_id 转成十进制数字", async () => {
    const { fn } = bothEndpoints();
    const map = await withClient(fn, (c) => c.chainIds(KEY));
    expect(map.ethereum).toBe(1);
    expect(map.base).toBe(8453); // 0x2105
  });

  it("缓存住:同一个 client 连问两次只拉一发", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => Effect.all([c.chainIds(KEY), c.chainIds(KEY)]));
    expect(calls).toHaveLength(1);
  });

  it("缓存跨 client 实例共享(CF Workers 上每请求一个 Layer,绑 Scope 就等于没缓存)", async () => {
    const base = freshBase();
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) => c.chainIds(KEY), { apiBase: base });
    await withClient(fn, (c) => c.chainIds(KEY), { apiBase: base });
    expect(calls).toHaveLength(1);
  });

  it("并发问也只拉一发(老那版没锁,6 个账户冷启会同时拉 6 发)", async () => {
    const { fn, calls } = bothEndpoints();
    await withClient(fn, (c) =>
      Effect.all([c.chainIds(KEY), c.chainIds(KEY), c.chainIds(KEY), c.chainIds(KEY)], {
        concurrency: "unbounded",
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("过了 TTL 就重拉", async () => {
    const base = freshBase();
    const { fn, calls } = bothEndpoints();
    await Effect.gen(function* () {
      const client = yield* make({ apiBase: base });
      yield* client.chainIds(KEY);
      yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
      yield* client.chainIds(KEY);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Fetcher, fn),
      Effect.provideService(RateLimitScopeOverride, "memory"),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
    );
    expect(calls).toHaveLength(2);
  });

  it("刷新失败但有旧映射 → 用旧的(chainId 不可变,旧的仍然正确)", async () => {
    const base = freshBase();
    let dead = false;
    const { fn } = stub(() => (dead ? json({}, { status: 503 }) : json(chainsFixture)));

    const map = await Effect.gen(function* () {
      const client = yield* make({ apiBase: base });
      yield* client.chainIds(KEY);
      dead = true;
      yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
      return yield* client.chainIds(KEY);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Fetcher, fn),
      Effect.provideService(RateLimitScopeOverride, "memory"),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
    );
    expect(map.ethereum).toBe(1);
  });

  it("一个映射都没有 → 硬失败,绝不退化成 slug 兜底形", async () => {
    // 兜底形会与规范形分裂身份、污染代币索引。失败即不产,整轮重试。
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.chainIds(KEY)))._tag).toBe("UpstreamUnavailableError");
  });

  it("空响应也算没拿到(200 但一条链都没有)", async () => {
    const { fn } = stub(() => json({ data: [] }));
    const err = await failing(fn, (c) => c.chainIds(KEY));
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("zerion");
  });
});

describe("portfolio", () => {
  it("打轻量端点(探活用,负载远小于 positions)", async () => {
    const { fn, calls } = stub(() => json({ data: {} }));
    await withClient(fn, (c) => c.portfolio({ address: ADDR, apiKey: KEY }));
    expect(calls[0].url.pathname).toBe(`/v1/wallets/${ADDR}/portfolio`);
  });
});

describe("错误归类", () => {
  // **zerion 没有归类差异**,这几条验的是 core 的默认规则在这条链路上确实通了。
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ errors: [{ title: "nope" }] }, init));
    return failing(fn, (c) => c.positions({ address: ADDR, apiKey: KEY }));
  };

  it("401 / 403 → 凭据问题(key 不对)", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 → 限流,带上 Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "5" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(5000);
  });

  it("5xx → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.positions({ address: ADDR, apiKey: KEY })))._tag).toBe(
      "UpstreamParseError",
    );
  });

  it("失败信息不带 query / key(原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    // 地址在 pathname 里(是 Zerion 的路径形状),但 key 与 query 绝不能出现。
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("filter[trash]");
  });
});
