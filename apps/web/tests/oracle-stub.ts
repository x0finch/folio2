import {
  DefiLogoResolver,
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
  refreshStalePrices: () => Effect.succeed(0),
  refreshStaleInfo: () => Effect.succeed(0),
  priceSeries: () => Effect.succeed([]),
  priceAt: () => Effect.succeed(Option.none()),
  topTokens: () => Effect.succeed([]),
  search: () => Effect.succeed([]),
  refreshCatalogue: () => Effect.succeed(0),
};

const emptyFx: FxRateResolver = {
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
  fiatRateSeries: () => Effect.succeed([]),
  fiatRateAt: () => Effect.succeed(Option.none()),
};

const emptyPlatforms: PlatformResolver = {
  resolve: (keys) => Effect.succeed(new Map([...keys].map((key) => [key, { key, name: key }]))),
  warm: () => Effect.void,
};

const emptyDefiLogos: DefiLogoResolver = {
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
};

const emptyMinter: TokenMinter = {
  of: () => Effect.succeed(new Map()),
};

export interface OracleStub {
  reader?: Partial<TokenReader>;
  fx?: Partial<FxRateResolver>;
  platforms?: Partial<PlatformResolver>;
  defiLogos?: Partial<DefiLogoResolver>;
  minter?: Partial<TokenMinter>;
}

const oracleStubLayer = (stub: OracleStub = {}) =>
  Layer.mergeAll(
    Layer.succeed(TokenReader, { ...emptyReader, ...stub.reader }),
    Layer.succeed(FxRateResolver, { ...emptyFx, ...stub.fx }),
    Layer.succeed(PlatformResolver, { ...emptyPlatforms, ...stub.platforms }),
    Layer.succeed(DefiLogoResolver, { ...emptyDefiLogos, ...stub.defiLogos }),
    Layer.succeed(TokenMinter, { ...emptyMinter, ...stub.minter }),
  );

// 跑一个用了参考层的 effect,拿 Promise —— 用例照旧 `await`。
export const runWithOracle = <A, E>(
  stub: OracleStub,
  effect: Effect.Effect<
    A,
    E,
    TokenReader | FxRateResolver | PlatformResolver | DefiLogoResolver | TokenMinter
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
    TokenReader | FxRateResolver | PlatformResolver | DefiLogoResolver | TokenMinter
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(oracleStubLayer(stub)),
      Effect.provide(TestContext.TestContext),
    ),
  );
