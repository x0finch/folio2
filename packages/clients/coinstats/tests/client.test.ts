import { Fetcher, type UpstreamError } from "@folio/client-core";
import { Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { type CoinstatsClientApi, type CoinstatsConfig, make } from "../src/client";
import { API_KEY_HEADER, COINSTATS_API_BASE } from "../src/constants";
import solanaFixture from "./fixtures/solana.json" with { type: "json" };
import suiFixture from "./fixtures/sui.json" with { type: "json" };

const KEY = "the-api-key";
const ADDR = "6dNVtBJdHRWQvvGqpuTLKZ4Q1234567890abcdefghij";

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

// 构造要 Scope(闸)→ 在 scope 里建了用、用完就扔。
//
// **闸一律用 `memory` 档** —— Effect 官方实现,桶绑在 scope 上、每次 make 一份,天然隔离。
// 生产走 `isolated`,那一档的算法行为在 `@folio/client-core` 的测试里验。
const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: CoinstatsClientApi) => Effect.Effect<A, E>,
  over: Partial<CoinstatsConfig> = {},
): Promise<A> =>
  Effect.gen(function* () {
    const client = yield* make({ rateLimitScope: "memory", ...over });
    return yield* use(client);
  }).pipe(
    Effect.scoped,
    Effect.provideService(Fetcher, fn),
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: CoinstatsClientApi) => Effect.Effect<unknown, UpstreamError>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("balance", () => {
  it("address 与 connectionId 走 query,apiKey 走头", async () => {
    const { fn, calls } = stub(() => json(solanaFixture));
    await withClient(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }));

    expect(calls[0].url.origin).toBe(COINSTATS_API_BASE);
    expect(calls[0].url.pathname).toBe("/wallet/balance");
    expect(calls[0].url.searchParams.get("address")).toBe(ADDR);
    expect(calls[0].url.searchParams.get("connectionId")).toBe("solana");
    // key 是凭据,走头不走 query —— query 会进 URL、进日志。
    expect((calls[0].init?.headers as Record<string, string>)[API_KEY_HEADER]).toBe(KEY);
    expect(calls[0].url.searchParams.has("apiKey")).toBe(false);
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    const { fn } = stub(() => json(solanaFixture));
    const coins = await withClient(fn, (c) =>
      c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
    );
    // 上游直接吐数组(不是 { data: [...] })。parse 归适配层(ADR 0036)。
    expect(coins).toEqual(solanaFixture);
    expect(Array.isArray(coins)).toBe(true);
  });

  it("connectionId 与 apiKey 都是每次传:一个 client 服务多条链、多个账户", async () => {
    const { fn, calls } = stub((url) =>
      json(url.searchParams.get("connectionId") === "sui-wallet" ? suiFixture : solanaFixture),
    );
    await withClient(fn, (c) =>
      Effect.all([
        c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
        c.balance({ connectionId: "sui-wallet", address: "0xabc", apiKey: "other-key" }),
      ]),
    );
    expect(calls[0].url.searchParams.get("connectionId")).toBe("solana");
    expect(calls[1].url.searchParams.get("connectionId")).toBe("sui-wallet");
    expect((calls[1].init?.headers as Record<string, string>)[API_KEY_HEADER]).toBe("other-key");
  });

  it("apiBase 可覆盖,且当不透明整串用", async () => {
    const { fn, calls } = stub(() => json(solanaFixture));
    await withClient(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }), {
      apiBase: "http://localhost:3099/cs-proxy",
    });
    expect(calls[0].url.href).toContain("/cs-proxy/wallet/balance");
  });
});

describe("blockchains", () => {
  it("只带 key,不带地址 —— 这是「这把 key 还有效吗」的实测", async () => {
    const { fn, calls } = stub(() => json([{ connectionId: "solana" }]));
    await withClient(fn, (c) => c.blockchains(KEY));
    expect(calls[0].url.pathname).toBe("/wallet/blockchains");
    expect(calls[0].url.searchParams.has("address")).toBe(false);
    expect((calls[0].init?.headers as Record<string, string>)[API_KEY_HEADER]).toBe(KEY);
  });
});

describe("限频:两个端点都过闸", () => {
  // **这里验的是结构,不是算法。** 闸本身的行为在 `@folio/client-core` 的测试里。
  //
  // `memory` 档 = 官方 token-bucket:limit 2 / 1250ms → 每 625ms 补一个令牌,
  // 前 2 发满额突发、第 3 发等一个令牌。
  const settledAfter = (ms: number, use: (c: CoinstatsClientApi) => Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const { fn } = stub(() => json(solanaFixture));
      const client = yield* make({ rateLimitScope: "memory" });
      const fiber = yield* Effect.fork(use(client).pipe(Effect.provideService(Fetcher, fn)));
      yield* TestClock.adjust(Duration.millis(ms));
      // 假 fetch 是 `Promise.resolve`,不归 TestClock 管 —— 让出几轮微任务把它跑干净。
      // 被闸拦住的那一侧在等虚拟时钟,让多少轮都不会完成,所以两侧都仍然准。
      yield* Effect.repeatN(Effect.yieldNow(), 50);
      return Option.isSome(yield* Fiber.poll(fiber));
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise);

  const threeBalances = (c: CoinstatsClientApi) =>
    Effect.all(
      Array.from({ length: 3 }, () =>
        Effect.orDie(c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY })),
      ),
    );

  it("超出突发的那一发要等", async () => {
    expect(await settledAfter(624, threeBalances)).toBe(false);
    expect(await settledAfter(625, threeBalances)).toBe(true);
  });

  it("blockchains 也过同一个闸(花的是同一把 key 的额度)", async () => {
    const mixed = (c: CoinstatsClientApi) =>
      Effect.all([
        Effect.orDie(c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY })),
        Effect.orDie(c.balance({ connectionId: "sui-wallet", address: ADDR, apiKey: KEY })),
        Effect.orDie(c.blockchains(KEY)),
      ]);
    expect(await settledAfter(624, mixed)).toBe(false);
    expect(await settledAfter(625, mixed)).toBe(true);
  });
});

describe("错误归类", () => {
  // **coinstats 没有归类差异**,这几条验的是 core 的默认规则在这条链路上确实通了。
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ message: "nope" }, init));
    return failing(fn, (c) => c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }));
  };

  it("401 / 403 → 凭据问题(key 不对)", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 → 限流,带上 Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "3" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(3000);
  });

  it("5xx → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    const err = await failing(fn, (c) =>
      c.balance({ connectionId: "solana", address: ADDR, apiKey: KEY }),
    );
    expect(err._tag).toBe("UpstreamParseError");
  });

  it("失败信息不带 query / key(原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("coinstats");
    expect(err.where).toBe("/wallet/balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(ADDR);
  });
});
