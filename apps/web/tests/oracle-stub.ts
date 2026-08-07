import {
  FxHistory,
  FxRateResolver,
  PlatformResolver,
  TokenMinter,
  TokenReader,
} from "@folio/oracle";
import { Effect, Layer, Option, TestClock, TestContext } from "effect";

// **app 侧服务端逻辑的一份共用测试装配。**
//
// 参考层从 #362 第 4 站起是 Effect 服务(`TokenReader` / `FxRateResolver` / …),所以
// 「注一个假 tokens 进去」变成了「provide 一个假 layer」。抄一遍 `Effect.provide(...)` 尾巴
// 的事只做一次(CODING.md:测试装配收成一份共用工具,抄九遍的东西每份都会慢慢长歪)。
//
// 各方法的缺省实现是**空**(空 Map / `none` / 0):用例只写它关心的那几个,别的动了就该红。

const emptyReader: TokenReader = {
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
};

const emptyFx: FxRateResolver = {
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
};

// 历史日汇率是**另一个服务**(#390 的 review 第 5 条把 fx 拆两半)—— 只碰现汇率的测试
// 因此不用再喂历史那半的假数据。
const emptyFxHistory: FxHistory = {
  rateSeries: () => Effect.succeed([]),
};

const emptyPlatforms: PlatformResolver = {
  resolve: (keys) => Effect.succeed(new Map([...keys].map((key) => [key, { key, name: key }]))),
  warm: () => Effect.void,
};

const emptyMinter: TokenMinter = {
  of: () => Effect.succeed(new Map()),
};

export interface OracleStub {
  reader?: Partial<TokenReader>;
  fx?: Partial<FxRateResolver>;
  fxHistory?: Partial<FxHistory>;
  platforms?: Partial<PlatformResolver>;
  minter?: Partial<TokenMinter>;
}

const oracleStubLayer = (stub: OracleStub = {}) =>
  Layer.mergeAll(
    Layer.succeed(TokenReader, { ...emptyReader, ...stub.reader }),
    Layer.succeed(FxRateResolver, { ...emptyFx, ...stub.fx }),
    Layer.succeed(FxHistory, { ...emptyFxHistory, ...stub.fxHistory }),
    Layer.succeed(PlatformResolver, { ...emptyPlatforms, ...stub.platforms }),
    Layer.succeed(TokenMinter, { ...emptyMinter, ...stub.minter }),
  );

// 跑一个用了参考层的 effect,拿 Promise —— 用例照旧 `await`。
export const runWithOracle = <A, E>(
  stub: OracleStub,
  effect: Effect.Effect<
    A,
    E,
    TokenReader | FxRateResolver | FxHistory | PlatformResolver | TokenMinter
  >,
): Promise<A> => Effect.runPromise(Effect.provide(effect, oracleStubLayer(stub)));

// 同上,但把时钟钉在一个固定时刻 —— 用到 `Clock`(如 `priceTickets` 的 `asOf`)的用例走这个,
// 别拿 `Date.now()` 去猜(CODING.md:时序断言用 `TestClock`、断言精确值)。
export const runWithOracleAt = <A, E>(
  nowMs: number,
  stub: OracleStub,
  effect: Effect.Effect<
    A,
    E,
    TokenReader | FxRateResolver | FxHistory | PlatformResolver | TokenMinter
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(oracleStubLayer(stub)),
      Effect.provide(TestContext.TestContext),
    ),
  );
