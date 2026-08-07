import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import type { ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import { RabbySigner, type SignRequest } from "@folio/rabby-client";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { rabbyProvider } from "../../../src/connectors/evm/rabby-provider";
import tokens from "./fixtures/rabby-cache-token-list.json";
import chains from "./fixtures/rabby-chain-list.json";
import protocols from "./fixtures/rabby-complex-protocol-list.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// 假签名器:真家伙靠 wasm(只在 Workers 里跑得动)。要验的是**接线**,签名算法不是被测对象。
const fakeSign: SignRequest = () =>
  Effect.succeed({ "X-Api-Ts": "1", "X-Api-Nonce": "n", "X-Api-Sign": "sig" });

function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("chain/list")) return json(chains);
    if (path.includes("complex_protocol")) return json(protocols);
    if (path.includes("cache_token_list")) return json(tokens);
    return json({ total_usd_value: 1 }); // total_balance
  });
}

type Ctx = Parameters<typeof rabbyProvider.fetchBalances>[0];
const ctx = (address = ADDR): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address } },
    creds: {},
  }) as unknown as Ctx;

// **rabby 有闸(limit=1)**,所以多发请求时要推虚拟时钟,否则第二发永远在等。
// fork → 反复「推一截 + 冲微任务」→ join:推的是虚拟时钟(不占真实时间),冲微任务是因为
// 假出网走的是 `Promise.resolve`,不归 TestClock 管(CODING.md 的 Effect 一节记着这条)。
const drive = <A, E>(effect: Effect.Effect<A, E, ProviderNeeds>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(effect);
    for (let i = 0; i < 20; i++) {
      yield* Effect.repeatN(Effect.yieldNow(), 20);
      yield* TestClock.adjust(Duration.seconds(1));
    }
    return yield* Fiber.join(fiber);
  });

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, drive(effect.pipe(Effect.provideService(RabbySigner, fakeSign))));
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> =>
  runClient(stub, drive(Effect.flip(effect).pipe(Effect.provideService(RabbySigner, fakeSign))));

describe("fetchBalances", () => {
  // ⚠️ **本 describe 内的顺序是有意义的**:链映射在 client 里缓存 24 小时,而那份缓存是**模块级**
  // (CF Workers 上每请求一次 runPromise,放 Scope 里等于每请求重置 —— 见 CODING.md 的 Effect 一节)。
  // 所以只有**第一条**用例见得到冷缓存。与其想办法绕开,不如把它变成覆盖:第一条钉冷启的三发与
  // 顺序,第二条钉「第二个账户只花两发」—— 那正是这份缓存存在的理由。
  it("冷启:三发按固定顺序 —— 链映射先拿,后两发的解析都要它", async () => {
    // 顺序是 `Effect.all` 顺序执行**唯一**可观测的后果,而且完全确定。
    // (不数「同时在飞几发」:那要么得让桩真的挂住,要么就是同一个 tick 里加减、恒等于 1 的假断言。)
    const stub = upstream();
    const { balances } = await run(stub, rabbyProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "spot")).toBe(true);
    expect(balances.some((b) => b.kind === "defi")).toBe(true);

    const paths = stub.calls.map((c) => c.request.url.pathname);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("chain/list");
    expect(paths[1]).toContain("cache_token_list");
    expect(paths[2]).toContain("complex_protocol");
  });

  it("链映射缓存 24h → **下一个账户只花两发**,不再问一次链清单", async () => {
    const stub = upstream();
    await run(stub, rabbyProvider.fetchBalances(ctx(`0x${"1".repeat(40)}`)));

    const paths = stub.calls.map((c) => c.request.url.pathname);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes("chain/list"))).toBe(false);
  });

  it("不要 provider key —— PC 是空的(这正是它当默认源的理由)", () => {
    expect(rabbyProvider.id).toBe("rabby");
    expect(rabbyProvider.creds).toEqual([]);
  });

  it("429 → 限流(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    expect((await failing(stub, rabbyProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
  });
});

describe("validateAccount", () => {
  it("200 → true(打最轻的 total_balance)", async () => {
    const stub = httpStub(() => json({ total_usd_value: 1 }));
    expect(await run(stub, rabbyProvider.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toContain("total_balance");
  });

  it("凭据被拒(403)→ false", async () => {
    const stub = httpStub(() => json({}, { status: 403 }));
    expect(await run(stub, rabbyProvider.validateAccount(ctx()))).toBe(false);
  });

  it("5xx → 走错误通道,不压成 false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    expect((await failing(stub, rabbyProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorUnavailableError",
    );
  });
});
