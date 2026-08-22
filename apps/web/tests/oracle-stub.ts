import { FxService, PlatformService, TokenService } from "@folio/oracle";
import { Effect, Layer, Option, TestClock, TestContext } from "effect";

// **app 侧服务端逻辑的一份共用测试装配。**
//
// 参考层从 #362 第 4 站起是 Effect 服务(`TokenService` / `FxService` / `PlatformService`),
// 所以「注一个假 tokens 进去」变成了「provide 一个假 layer」。抄一遍 `Effect.provide(...)` 尾巴
// 的事只做一次(CODING.md:测试装配收成一份共用工具,抄九遍的东西每份都会慢慢长歪)。
//
// **三个桩,不是五个** —— 参考层的服务从五个收成三个(读写合成 `TokenService`、现汇率与历史
// 汇率合成 `FxService`)。能力一个没少,只是不必再为「只用得到现汇率」的用例喂一份历史汇率的
// 空桩:那两半现在是同一个 `emptyFx` 的两个字段。
//
// 各方法的缺省实现是**空**(空 Map / `none` / 0):用例只写它关心的那几个,别的动了就该红。
//
// 三个桩都走服务自己的构造器(`new TokenService(…)`)—— 它们是 `Effect.Service` class(#501),
// 裸对象少一个 `_tag`,而且从构造器建出来的和生产那条路建出来的是同一种东西。

const emptyTokens = new TokenService({
  mint: () => Effect.succeed(new Map()),
  enrich: () => Effect.succeed(new Map()),
  logoUrlById: () => Effect.succeed(Option.none()),
  priceOf: () => Effect.succeed(Option.none()),
  priceByRef: () => Effect.succeed(Option.none()),
  pricesByRefs: () => Effect.succeed(new Map()),
  refreshStale: () => Effect.succeed({ prices: 0, infos: 0, degraded: false }),
  priceSeries: () => Effect.succeed([]),
  priceAt: () => Effect.succeed(Option.none()),
  topTokens: () => Effect.succeed([]),
  search: () => Effect.succeed([]),
  refreshCatalogue: () => Effect.succeed(0),
});

const emptyFx = new FxService({
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
  rateSeries: () => Effect.succeed([]),
});

const emptyPlatforms = new PlatformService({
  resolve: (keys) => Effect.succeed(new Map([...keys].map((key) => [key, { key, name: key }]))),
  warm: () => Effect.void,
});

export interface OracleStub {
  tokens?: Partial<TokenService>;
  fx?: Partial<FxService>;
  platforms?: Partial<PlatformService>;
}

const oracleStubLayer = (stub: OracleStub = {}) =>
  Layer.mergeAll(
    Layer.succeed(TokenService, new TokenService({ ...emptyTokens, ...stub.tokens })),
    Layer.succeed(FxService, new FxService({ ...emptyFx, ...stub.fx })),
    Layer.succeed(PlatformService, new PlatformService({ ...emptyPlatforms, ...stub.platforms })),
  );

// 跑一个用了参考层的 effect —— 拿 Promise,用例照旧 `await`。
export const runWithOracle = <A, E>(
  stub: OracleStub,
  effect: Effect.Effect<A, E, TokenService | FxService | PlatformService>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, oracleStubLayer(stub)));

// 同上,但把时钟钉在一个固定时刻 —— 用到 `Clock`(如 `priceTickets` 的 `asOf`)的用例走这个,
// 别拿 `Date.now()` 去猜(CODING.md:时序断言用 `TestClock`、断言精确值)。
export const runWithOracleAt = <A, E>(
  nowMs: number,
  stub: OracleStub,
  effect: Effect.Effect<A, E, TokenService | FxService | PlatformService>,
): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(oracleStubLayer(stub)),
      Effect.provide(TestContext.TestContext),
    ),
  );
