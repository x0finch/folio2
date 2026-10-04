import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { GlobalRefIndexService, Oracle } from "../src";
import { FxService } from "../src/fx";
import { PlatformService } from "../src/platforms";
import { TokenService } from "../src/tokens";
import { harness, now0, upstreamDown } from "./fakes";

// 装配层。两件事只能在这一层被验到:
//   ① `oracleLayer` 到底提供了哪几个服务、要哪几个端口(装配点照着它接线)
//   ② **写路径不为目录新鲜度出网**(#216)—— mint 与候选源各自的单测都看不见「装配时把哪个
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
  // **聚合挂的是本尊,不是同名的另一份。** `Oracle` 只把三个域服务放到三个字段上,所以
  // `(yield* Oracle).fx` 必须和 `yield* FxService` 是同一个对象 —— 不是的话就意味着装配里
  // 有人又建了一套,那份的缓存、SWR 状态跟另一份对不上(#504 T15)。
  it("Oracle 的三个字段就是三个域服务本尊", async () => {
    const h = harness();
    await h.run(
      Effect.gen(function* () {
        const oracle = yield* Oracle;
        expect(oracle.tokens).toBe(yield* TokenService);
        expect(oracle.fx).toBe(yield* FxService);
        expect(oracle.platforms).toBe(yield* PlatformService);
      }),
    );
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

describe("全局维护任务不挂 per-user 门面", () => {
  // `GlobalRefIndexService` 不进 `oracleLayer`:它的依赖只有两个全局端口,cron 单独 provide
  // 那个 layer 就能跑 —— 不必先假造一个用户、也不必建 per-user 的三张 store。
  it("刷全局映射表不要 userId、也不要 per-user store:拉 → 一次整份灌 → 记得刷新时刻", async () => {
    const h = harness();
    h.upstream.globalRefIndex = {
      rows: [
        { chainRef: "evm:1/contract:0xa0b8", upstreamRef: "src/issued:usd-coin" },
        { chainRef: "solana/contract:EPjF", upstreamRef: "src/issued:usd-coin" },
      ],
      unmatchedPlatforms: [],
      skipped: 7,
    };

    await h.run(
      Effect.gen(function* () {
        const svc = yield* GlobalRefIndexService;
        expect(yield* svc.refreshedAt()).toEqual(Option.none());

        const summary = yield* svc.warm();
        // 差量写(#FOL-68):空库首刷 → 两行都是新增,改/删各 0。计数从 store 一路传到 cron 日志。
        expect(summary).toEqual({
          rows: 2,
          unmatchedPlatforms: [],
          skipped: 7,
          updated: 0,
          inserted: 2,
          deleted: 0,
        });
        expect(h.globalRefIndex.writes).toBe(1); // 一次整份写
        // 时刻取自 `Clock`(不再由调用方传一个 `now` 进来)。
        expect(yield* svc.refreshedAt()).toEqual(Option.some(now0));
      }),
    );
  });

  // 迁移前这是 `OracleWarmConfig.onWarn` 一个配置回调。现在走 Effect 的日志系统,
  // 落到哪由 cron 提供的 Logger layer 决定 —— 少一个配置字段,而且任何调用点都能记。
  it("失配落一条 warning(带 namer 与链名);没有失配就不吵", async () => {
    const h = harness();
    h.upstream.globalRefIndex = { rows: [], unmatchedPlatforms: ["sui"], skipped: 0 };
    await h.run(Effect.flatMap(GlobalRefIndexService, (s) => s.warm()));

    const warns = h.logs.filter((l) => l.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.annotations).toEqual({ namer: "src", platforms: ["sui"] });

    h.upstream.globalRefIndex = { rows: [], unmatchedPlatforms: [], skipped: 0 };
    await h.run(Effect.flatMap(GlobalRefIndexService, (s) => s.warm()));
    expect(h.logs.filter((l) => l.level === "WARN")).toHaveLength(1);
  });

  // 与读路径相反:cron 需要知道这一轮白跑了(降级在这儿等于把一次静默故障变成两次)。
  it("上游挂了 → 错误交给 cron,不降级", async () => {
    const h = harness();
    h.upstream.fail = upstreamDown();
    const result = await h.run(
      Effect.either(Effect.flatMap(GlobalRefIndexService, (s) => s.warm())),
    );
    expect(result._tag).toBe("Left");
    expect(h.globalRefIndex.writes).toBe(0);
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
    // 顺带:`oracleLayer` 的 `R` 里没有 `CandidateSource`(类型上就成立,装配点不必知道它);
    // harness 只给八个端口,mint 的 symbol 那一档照样走通 —— 这是它的运行时证据。
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
