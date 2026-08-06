import { Fetcher, SigningFailure, type UpstreamError } from "@folio/client-core";
import { Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { make, parseChainIds, type RabbyClientApi, type RabbyConfig } from "../src/client";
import { CHAINS_CACHE_TTL_MS, RABBY_API_BASE } from "../src/constants";
import { RabbySigner, type SignRequest } from "../src/signer";
import tokensFixture from "./fixtures/cache-token-list.json" with { type: "json" };
import chainListFixture from "./fixtures/chain-list.json" with { type: "json" };
import protocolsFixture from "./fixtures/complex-protocol-list.json" with { type: "json" };

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

// 假签名器:记下**它被要求签的是什么**。真家伙靠 wasm(只在 Workers 里跑得动),而这里要验的是
// **接线** —— 递进去的 params 是不是真正发出去那份、头有没有带全。签名算法本身不是被测对象。
function fakeSigner() {
  const signed: Array<{ method: string; path: string; params: Record<string, unknown> }> = [];
  const sign: SignRequest = (method, path, params) => {
    signed.push({ method, path, params });
    return Effect.succeed({
      "X-Api-Ts": "1700000000",
      "X-Api-Nonce": "n0nce",
      "X-Api-Ver": "0.93.49",
      "X-Api-Sign": `sig(${method} ${path} ${JSON.stringify(params)})`,
      "X-Client": "Rabby",
      "X-Version": "0.93.49",
    });
  };
  return { sign, signed };
}

// 缓存按 baseUrl 分桶 → 每个用例给自己一个 base 就天然隔离,不需要 resetForTests。
let bases = 0;
const freshBase = () => `https://rabby-${bases++}.test`;

const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: RabbyClientApi) => Effect.Effect<A, E>,
  over: Partial<RabbyConfig> = {},
  sign: SignRequest = fakeSigner().sign,
): Promise<A> =>
  Effect.gen(function* () {
    const client = yield* make({ rateLimitScope: "memory", apiBase: freshBase(), ...over });
    return yield* use(client);
  }).pipe(
    Effect.scoped,
    Effect.provideService(Fetcher, fn),
    Effect.provideService(RabbySigner, sign),
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: RabbyClientApi) => Effect.Effect<unknown, UpstreamError>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const byPath = () =>
  stub((url) =>
    url.pathname.includes("chain/list")
      ? json(chainListFixture)
      : url.pathname.includes("complex_protocol")
        ? json(protocolsFixture)
        : json(tokensFixture),
  );

describe("签名", () => {
  it("签的 params 就是真正发出去的 query(上游按 key 排序后哈希,差一个就白签)", async () => {
    const { fn, calls } = byPath();
    const signer = fakeSigner();
    await withClient(fn, (c) => c.tokens(ADDR), {}, signer.sign);

    expect(signer.signed[0].method).toBe("GET");
    expect(signer.signed[0].path).toBe("/v1/user/cache_token_list");
    expect(signer.signed[0].params).toEqual({ id: ADDR });
    // 发出去的 query 与被签的那份一致。
    expect(calls[0].url.searchParams.get("id")).toBe(ADDR);
    expect([...calls[0].url.searchParams.keys()]).toEqual(["id"]);
  });

  it("六个签名头全带上(少一个就掉回「每 40 秒一发」的档位)", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => c.tokens(ADDR));
    const h = calls[0].init?.headers as Record<string, string>;
    for (const key of [
      "X-Api-Ts",
      "X-Api-Nonce",
      "X-Api-Ver",
      "X-Api-Sign",
      "X-Client",
      "X-Version",
    ]) {
      expect(h[key]).toBeTruthy();
    }
    expect(h.accept).toBe("application/json");
  });

  it("无 query 的端点签的是空 params", async () => {
    const { fn } = byPath();
    const signer = fakeSigner();
    await withClient(fn, (c) => c.chainIds, {}, signer.sign);
    expect(signer.signed[0].path).toBe("/v1/chain/list");
    expect(signer.signed[0].params).toEqual({});
  });

  it("签不出来 → 凭据问题,不是传输故障(重试白赔,通常是上游改了签名协议)", async () => {
    const { fn } = byPath();
    const boom: SignRequest = (_m, path) => Effect.fail(new SigningFailure({ where: path }));
    const err = await Effect.gen(function* () {
      const client = yield* make({ rateLimitScope: "memory", apiBase: freshBase() });
      return yield* Effect.flip(client.tokens(ADDR));
    }).pipe(
      Effect.scoped,
      Effect.provideService(Fetcher, fn),
      Effect.provideService(RabbySigner, boom),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
    );
    expect(err._tag).toBe("UpstreamAuthError");
  });
});

describe("端点", () => {
  it("tokens:一次回全链,地址走 id", async () => {
    const { fn, calls } = byPath();
    const rows = await withClient(fn, (c) => c.tokens(ADDR), { apiBase: RABBY_API_BASE });
    expect(calls[0].url.origin).toBe(RABBY_API_BASE);
    expect(calls[0].url.pathname).toBe("/v1/user/cache_token_list");
    expect(rows).toEqual(tokensFixture);
  });

  it("protocols:同样一次回全链", async () => {
    const { fn, calls } = byPath();
    const rows = await withClient(fn, (c) => c.protocols(ADDR));
    expect(calls[0].url.pathname).toBe("/v1/user/complex_protocol_list");
    expect(rows).toEqual(protocolsFixture);
  });

  it("totalBalance:最轻的端点,探活用", async () => {
    const { fn, calls } = stub(() => json({ total_usd_value: 1 }));
    await withClient(fn, (c) => c.totalBalance(ADDR));
    expect(calls[0].url.pathname).toBe("/v1/user/total_balance");
  });

  it("apiBase 可覆盖,且当不透明整串用", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => c.tokens(ADDR), { apiBase: "http://localhost:3099/rabby-proxy" });
    expect(calls[0].url.href).toContain("/rabby-proxy/v1/user/cache_token_list");
  });
});

describe("chainIds", () => {
  it("community_id 就是规范 chainId", () => {
    const map = parseChainIds([
      { id: "eth", community_id: 1 },
      { id: "bsc", community_id: 56 },
      { id: "arb", community_id: 42161 },
      { id: "broken" }, // 没有 community_id → 跳过,不产兜底形
    ]);
    expect(map).toEqual({ eth: 1, bsc: 56, arb: 42161 });
  });

  it("缓存住:连问两次只拉一发", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) => Effect.all([c.chainIds, c.chainIds]));
    expect(calls).toHaveLength(1);
  });

  it("并发问也只拉一发", async () => {
    const { fn, calls } = byPath();
    await withClient(fn, (c) =>
      Effect.all([c.chainIds, c.chainIds, c.chainIds], { concurrency: "unbounded" }),
    );
    expect(calls).toHaveLength(1);
  });

  it("刷新失败但有旧映射 → 用旧的", async () => {
    const base = freshBase();
    let dead = false;
    const { fn } = stub(() => (dead ? json({}, { status: 503 }) : json(chainListFixture)));
    const map = await Effect.gen(function* () {
      const client = yield* make({ rateLimitScope: "memory", apiBase: base });
      yield* client.chainIds;
      dead = true;
      yield* TestClock.adjust(Duration.millis(CHAINS_CACHE_TTL_MS + 1));
      return yield* client.chainIds;
    }).pipe(
      Effect.scoped,
      Effect.provideService(Fetcher, fn),
      Effect.provideService(RabbySigner, fakeSigner().sign),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
    );
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });

  it("一个映射都没有 → 硬失败,绝不退化成 slug 兜底形", async () => {
    const { fn } = stub(() => json([]));
    const err = await failing(fn, (c) => c.chainIds);
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe("rabby");
  });
});

describe("限频:limit=1,不许突发", () => {
  // rabby 掐的是**瞬时并发**不是总量,而且 429 不带 Retry-After —— 策略是「从不撞」。
  // `memory` 档 = 官方 token-bucket:limit 1 / 125ms → 第 2 发就要等 125ms。
  const settledAfter = (ms: number, use: (c: RabbyClientApi) => Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const { fn } = byPath();
      const client = yield* make({ rateLimitScope: "memory", apiBase: freshBase() });
      const fiber = yield* Effect.fork(
        use(client).pipe(
          Effect.provideService(Fetcher, fn),
          Effect.provideService(RabbySigner, fakeSigner().sign),
        ),
      );
      yield* TestClock.adjust(Duration.millis(ms));
      yield* Effect.repeatN(Effect.yieldNow(), 50);
      return Option.isSome(yield* Fiber.poll(fiber));
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise);

  it("第二发就要等(不许突发)", async () => {
    const two = (c: RabbyClientApi) =>
      Effect.all([Effect.orDie(c.tokens(ADDR)), Effect.orDie(c.tokens(ADDR))]);
    expect(await settledAfter(124, two)).toBe(false);
    expect(await settledAfter(125, two)).toBe(true);
  });
});

describe("错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ err: 1 }, init));
    return failing(fn, (c) => c.tokens(ADDR));
  };

  it("429 → 限流(rabby 不给 Retry-After,所以 retryAfterMs 是 undefined)", async () => {
    const err = await failWith({ status: 429 });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
  });

  it("5xx / 出不去 → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.tokens(ADDR)))._tag).toBe("UpstreamParseError");
  });

  it("失败信息不带 query / 地址(原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    expect(err.where).toBe("/v1/user/cache_token_list");
    expect(JSON.stringify(err)).not.toContain(ADDR);
  });
});
