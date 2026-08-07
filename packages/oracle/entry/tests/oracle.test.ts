import { Duration, Effect, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import {
  FxService,
  oracleLayer,
  PlatformService,
  refIndexRefreshedAt,
  TokenService,
  warmRefIndex,
} from "../src";
import {
  fakeRefIndexStore,
  fakeTokenPriceStore,
  fakeTokenStore,
  harness,
  now0,
  upstreamDown,
} from "./fakes";

// 装配层。三件事只能在这一层被验到:
//   ① `oracleLayer` 到底提供了哪几个服务、要哪几个端口(装配点照着它接线)
//   ② 端口契约的往返(内存假实现钉住「读什么写什么」)
//   ③ **写路径不为目录新鲜度出网**(#216)—— mint 与候选源各自的单测都看不见「装配时把哪个
//      实现接了进去」,而洞恰恰在那一行
//
// **`DefiLogoResolver` 不在这一层了**(移回 app):它的 `R` 里一个上游都没有,那本身就是
// 「不属于参考层」的类型级写法;现在是 app 的 `defi-logo-store.ts`,测试在 apps/web 那边。
//
// **「每个用户一份」的保证换了地方**:以前是 `createOracleFor(cfg)(userId)` 那个显式工厂,
// 现在是 app 侧按 userId 现建的三个 per-user store layer(`oracleLayerFor(userId)`)。
// 服务的方法签名里依旧一个 user 参数都没有 —— 拿错用户在编译期就发生不了,而这一层压根不知道
// 有 userId 这回事(所以这里也测不了它;真正的隔离由 `@folio/db` 那几个 store 自己的测试盯)。

describe("oracleLayer —— 一次装配拿到三个服务", () => {
  it("三个服务都在,而且只要那八个端口就能起来(`CandidateSource` 不外露)", async () => {
    const h = harness({ rates: { EUR: 1.09 }, chains: [{ key: "evm:1", name: "Ethereum" }] });
    await h.run(
      Effect.gen(function* () {
        // 三个都能从 context 里拿出来,而 provide 进去的只有端口(见 fakes 的 `ports`)。
        // **合并没有让能力消失**:读、写、现汇率、历史汇率、平台五样仍然一个不少,
        // 只是分别落在三个服务的方法上 —— 这一条把「方法还在」也钉住。
        expect(yield* Effect.map(TokenService, (t) => typeof t.enrich)).toBe("function");
        expect(yield* Effect.map(TokenService, (t) => typeof t.mint)).toBe("function");
        expect(yield* Effect.map(FxService, (f) => typeof f.resolve)).toBe("function");
        expect(yield* Effect.map(FxService, (f) => typeof f.rateSeries)).toBe("function");
        expect(yield* Effect.map(PlatformService, (p) => typeof p.resolve)).toBe("function");
      }),
    );
  });

  // `oracleLayer` 的 `R` 里没有 `CandidateSource` —— 这一条在类型上就成立(装配点不必知道它),
  // 这里补一个运行时的证据:只给八个端口,mint 的 symbol 那一档照样能走通。
  it("装配点不 provide 候选源,mint 仍然按 symbol 认得出币", async () => {
    const h = harness();
    h.upstream.markets = [
      {
        ref: "src/issued:bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 1, marketCapRank: 1, asOf: now0 },
      },
    ];
    const ids = await h.run(
      Effect.flatMap(TokenService, (t) =>
        t.mint([{ ref: "binance/issued:BTC", seed: { symbol: "BTC" } }]),
      ),
    );
    expect(h.store.refs.get("src/issued:bitcoin")).toBe(ids.get("binance/issued:BTC"));
  });

  it("`oracleLayer` 是纯装配 —— 建它本身不碰任何端口", async () => {
    const h = harness();
    await h.run(Effect.void);
    // build 三个服务只是把端口从 context 里取出来存进闭包:一次读、一次写都不该发生。
    expect(h.cache.reads + h.cache.writes).toBe(0);
    expect(h.upstream.calls).toEqual([]);
    expect(h.store.rows.size).toBe(0);
  });
});

describe("契约往返(内存假实现)", () => {
  // 端口的假实现本身不需要参考层的服务,但要虚拟时钟(TTL / stale 走 `Clock`)。
  const run = <A, E>(e: Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.zipRight(TestClock.setTime(now0), e).pipe(Effect.provide(TestContext.TestContext)),
    );

  it("代币表:建行 → 挂 ref → 按 id 读回;并发建同一条 ref 幂等", async () => {
    const store = fakeTokenStore();
    const id = await run(
      store.create({ symbol: "USDC", name: "USD Coin" }, ["evm:1/contract:0xa0b8"]),
    );

    expect(await run(store.findByRefs(["evm:1/contract:0xa0b8"]))).toEqual(
      new Map([["evm:1/contract:0xa0b8", { tokenId: id, linked: false }]]),
    );
    expect(Option.getOrThrow(await run(store.getById(id)))).toMatchObject({
      symbol: "USDC",
      ref: null,
    });

    const [a, b] = await run(
      Effect.all(
        [
          store.create({ symbol: "X" }, ["evm:1/contract:0xdead"]),
          store.create({ symbol: "X" }, ["evm:1/contract:0xdead"]),
        ],
        { concurrency: 2 },
      ),
    );
    expect(a).toBe(b);
  });

  it("价 store:写 → 读回;过期不删,读出带 stale", async () => {
    const prices = fakeTokenPriceStore();
    await run(
      Effect.gen(function* () {
        yield* prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: now0 }], 1000);
        expect((yield* prices.getByIds(["tk_1"])).get("tk_1")).toMatchObject({
          unitPrice: 60000,
          stale: false,
        });

        yield* TestClock.adjust(Duration.millis(2000));
        expect((yield* prices.getByIds(["tk_1"])).get("tk_1")).toMatchObject({ stale: true });
      }),
    );
  });

  it("全局映射:按 (upstream, chainRef) 点查回整条 upstream ref;miss 的键不出现", async () => {
    const store = fakeRefIndexStore();
    expect(await run(store.refreshedAt("src"))).toEqual(Option.none());

    await run(
      store.putAll(
        [{ chainRef: "evm:1/contract:0xa0b8", upstreamRef: "src/issued:usd-coin" }],
        123,
      ),
    );
    expect(await run(store.refreshedAt("src"))).toEqual(Option.some(123));
    expect(
      await run(store.lookup("src", ["evm:1/contract:0xa0b8", "evm:1/contract:0xdead"])),
    ).toEqual(new Map([["evm:1/contract:0xa0b8", "src/issued:usd-coin"]]));
    // 换个上游就查不到 —— 这正是「加源只加行」的另一面。
    expect(await run(store.lookup("other", ["evm:1/contract:0xa0b8"]))).toEqual(new Map());
  });
});

describe("全局维护任务不挂 per-user 门面", () => {
  // 这两件**不是服务**(没有 Tag):它们的依赖写在 `R` 上(`GlobalTokenRefIndexStore | TokenUpstream`),
  // cron 直接 provide 那两个端口就能跑 —— 不必先假造一个用户、也不必建 per-user 的三张 store。
  it("刷全局映射表不要 userId、也不要 per-user store:拉 → 一次整份灌 → 记得刷新时刻", async () => {
    const h = harness();
    h.upstream.refIndex = {
      rows: [
        { chainRef: "evm:1/contract:0xa0b8", upstreamRef: "src/issued:usd-coin" },
        { chainRef: "solana/contract:EPjF", upstreamRef: "src/issued:usd-coin" },
      ],
      unmatchedPlatforms: [],
      skipped: 7,
    };

    await h.run(
      Effect.gen(function* () {
        expect(yield* refIndexRefreshedAt()).toEqual(Option.none());

        const summary = yield* warmRefIndex();
        expect(summary).toEqual({ rows: 2, unmatchedPlatforms: [], skipped: 7 });
        expect(h.refIndex.writes).toBe(1); // 一次整份写
        // 时刻取自 `Clock`(不再由调用方传一个 `now` 进来)。
        expect(yield* refIndexRefreshedAt()).toEqual(Option.some(now0));
      }),
    );
  });

  // 迁移前这是 `OracleWarmConfig.onWarn` 一个配置回调。现在走 Effect 的日志系统,
  // 落到哪由 cron 提供的 Logger layer 决定 —— 少一个配置字段,而且任何调用点都能记。
  it("失配落一条 warning(带 namer 与链名);没有失配就不吵", async () => {
    const h = harness();
    h.upstream.refIndex = { rows: [], unmatchedPlatforms: ["sui"], skipped: 0 };
    await h.run(warmRefIndex());

    const warns = h.logs.filter((l) => l.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.annotations).toEqual({ namer: "src", platforms: ["sui"] });

    h.upstream.refIndex = { rows: [], unmatchedPlatforms: [], skipped: 0 };
    await h.run(warmRefIndex());
    expect(h.logs.filter((l) => l.level === "WARN")).toHaveLength(1);
  });

  // 与读路径相反:cron 需要知道这一轮白跑了(降级在这儿等于把一次静默故障变成两次)。
  it("上游挂了 → 错误交给 cron,不降级", async () => {
    const h = harness();
    h.upstream.fail = upstreamDown();
    const result = await h.run(Effect.either(warmRefIndex()));
    expect(result._tag).toBe("Left");
    expect(h.refIndex.writes).toBe(0);
  });
});

// 本条是 #216 的核心回归。装配层是它唯一能被验到的地方 —— mint 与候选源各自的单测都看不见
// 「装配时把哪个实现接了进去」,而洞恰恰在那一行:以前是 `candidates: this.tokens.candidates`。
describe("写路径不为目录新鲜度出网(#216)", () => {
  const POL = {
    ref: "src/issued:polygon-ecosystem-token",
    symbol: "POL",
    name: "POL",
    price: { unitPrice: 1, marketCapRank: 76, asOf: 0 },
  };

  it("warm 过期之后 mint 按 symbol 认币 —— 零请求", async () => {
    const h = harness();
    h.upstream.markets = [POL];
    await h.run(
      Effect.gen(function* () {
        // 先让橱窗把 blob 建起来(用户打开过一次选币下拉)。
        yield* Effect.flatMap(TokenService, (t) => t.topTokens(10));
        const after = h.upstream.calls.length;

        // 时钟推过价的 TTL:橱窗会认为该刷了,mint 不该。
        yield* TestClock.adjust(Duration.millis(24 * 60 * 60 * 1000));
        const ids = yield* Effect.flatMap(TokenService, (t) =>
          t.mint([{ ref: "binance/issued:POL", seed: { symbol: "POL" } }]),
        );

        expect(ids.get("binance/issued:POL")).toBeDefined(); // 认出来了(用的是旧目录)
        expect(h.upstream.calls).toHaveLength(after); // 而且一次网都没出
      }),
    );
  });

  it("对照:同样过期,橱窗**会**刷 —— 差别只在读者是谁", async () => {
    const h = harness();
    h.upstream.markets = [POL];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenService;
        yield* tokens.topTokens(10);
        const after = h.upstream.calls.length;

        yield* TestClock.adjust(Duration.millis(24 * 60 * 60 * 1000));
        yield* tokens.topTokens(10);
        expect(h.upstream.calls.length).toBeGreaterThan(after);
      }),
    );
  });

  it("冷缓存下 mint 仍取一次 —— 否则按 symbol 认的币集体认不出来", async () => {
    const h = harness();
    h.upstream.markets = [POL];
    const ids = await h.run(
      Effect.flatMap(TokenService, (t) =>
        t.mint([{ ref: "binance/issued:POL", seed: { symbol: "POL" } }]),
      ),
    );
    expect(ids.get("binance/issued:POL")).toBeDefined();
    expect(h.upstream.calls).toHaveLength(1);
  });
});

// `oracleLayer` 本身也要被直接用一次(不经 harness 的那层包装)—— 它是装配点唯一 import 的东西。
describe("oracleLayer 的类型面", () => {
  it("它是一个 Layer,且把五个服务一起给出去", () => {
    expect(Layer.isLayer(oracleLayer)).toBe(true);
  });
});
