import { Oracle } from "@folio/oracle";
import { Effect, Layer, Option, TestClock, TestContext } from "effect";

// **app 侧服务端逻辑的一份共用测试装配。**
//
// 参考层是 Effect 服务(#362 第 4 站),所以「注一个假 tokens 进去」变成了「provide 一个假
// layer」。抄一遍 `Effect.provide(...)` 尾巴的事只做一次(CODING.md:测试装配收成一份共用工具,
// 抄九遍的东西每份都会慢慢长歪)。
//
// **打的是聚合 `Oracle`,不是三个域服务**(#504 T13:那三个 Tag 不再出包)。被测代码只认得
// 这一张门票,桩自然也只需要造这一张 —— 三个字段就是它的全部面。
//
// 各方法的缺省实现是**空**(空 Map / `none` / 0):用例只写它关心的那几个,别的动了就该红。
//
// **三个空桩各自按真接口标注,只减掉 `_tag`。** 那个字段是 `Effect.Service` 给 Tag 机制用的
// 品牌,嵌在聚合的字段上时运行时没人读它;而标注留着的那半才是要紧的 —— 桩的每个方法签名
// 仍然被逐个对着真服务检查(实测:把一个方法的返回类型改错,这里当场红)。
type StubOf<S> = Omit<S, "_tag">;

const emptyTokens: StubOf<Oracle["tokens"]> = {
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
};

const emptyFx: StubOf<Oracle["fx"]> = {
  resolve: () => Effect.succeed(Option.none()),
  warm: () => Effect.void,
  rateSeries: () => Effect.succeed([]),
};

const emptyPlatforms: StubOf<Oracle["platforms"]> = {
  resolve: (keys) => Effect.succeed(new Map([...keys].map((key) => [key, { key, name: key }]))),
  warm: () => Effect.void,
};

export interface OracleStub {
  tokens?: Partial<Oracle["tokens"]>;
  fx?: Partial<Oracle["fx"]>;
  platforms?: Partial<Oracle["platforms"]>;
}

// 只有这一处 `as`,而且只为补上三个 `_tag`(上面 `StubOf` 减掉的那个)—— 方法签名两边
// 都已经检查过了:空桩靠标注,用例给的那半靠 `Partial<…>`。
const oracleStubLayer = (stub: OracleStub = {}) =>
  Layer.succeed(
    Oracle,
    new Oracle({
      tokens: { ...emptyTokens, ...stub.tokens },
      fx: { ...emptyFx, ...stub.fx },
      platforms: { ...emptyPlatforms, ...stub.platforms },
    } as Oracle),
  );

// 跑一个用了参考层的 effect —— 拿 Promise,用例照旧 `await`。
export const runWithOracle = <A, E>(
  stub: OracleStub,
  effect: Effect.Effect<A, E, Oracle>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, oracleStubLayer(stub)));

// 同上,但把时钟钉在一个固定时刻 —— 用到 `Clock`(如 `priceTickets` 的 `asOf`)的用例走这个,
// 别拿 `Date.now()` 去猜(CODING.md:时序断言用 `TestClock`、断言精确值)。
export const runWithOracleAt = <A, E>(
  nowMs: number,
  stub: OracleStub,
  effect: Effect.Effect<A, E, Oracle>,
): Promise<A> =>
  Effect.runPromise(
    Effect.zipRight(TestClock.setTime(nowMs), effect).pipe(
      Effect.provide(oracleStubLayer(stub)),
      Effect.provide(TestContext.TestContext),
    ),
  );
