import { dayBucketOf, MS_PER_DAY, PRICE_TTL_MS, type TokenInfo } from "@folio/oracle-basic";
import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { TokenReader } from "../src";
import { harness, now0, upstreamDown } from "./fakes";

const NOW = now0; // 落在某个 UTC 日的中段
const TODAY = Math.floor(NOW / MS_PER_DAY);
const SRC_BTC = "src/issued:bitcoin";

const info = (over: Partial<TokenInfo> & { id: string }): TokenInfo => ({
  ref: SRC_BTC,
  symbol: "BTC",
  name: "Bitcoin",
  infoStale: false, // 默认已刷过 —— 要测刷新的用例自己传 true
  ...over,
});

const setup = (rows: TokenInfo[] = []) => harness({ seedRows: rows });

describe("富化 —— 两个 store 各读自己那半,服务层合成整行", () => {
  it("按 token_id 取,输入不再需要 symbol 或 tokenRef", async () => {
    const h = setup([
      info({ id: "tk_1", logo: "b.png" }),
      info({ id: "tk_2", ref: null, symbol: "WAT", name: "Whatever", providerLogo: "p.png" }),
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put(
          [{ tokenId: "tk_1", unitPrice: 60000, marketCapRank: 1, asOf: NOW }],
          PRICE_TTL_MS,
        );

        const got = yield* tokens.enrich(["tk_1", "tk_2", "tk_missing"]);
        expect(got.size).toBe(2);
        expect(got.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "b.png" });
        expect(got.get("tk_1")?.price).toMatchObject({
          unitPrice: 60000,
          marketCapRank: 1,
          stale: false,
        });
        expect(got.get("tk_2")?.price).toBeUndefined(); // 没价的行照样出 info
      }),
    );
  });

  it("空输入不查库", async () => {
    const h = setup();
    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.enrich([])))).toEqual(new Map());
  });

  it("「上游认没认出来」就看 ref 空不空,不存额外状态", async () => {
    const h = setup([info({ id: "tk_1" }), info({ id: "tk_2", ref: null, symbol: "WAT" })]);
    const got = await h.run(Effect.flatMap(TokenReader, (t) => t.enrich(["tk_1", "tk_2"])));

    expect(got.get("tk_1")?.ref).toBe(SRC_BTC);
    expect(got.get("tk_2")?.ref).toBeNull();
    // 行上没有孤儿标记、没有复查时刻,也没有任何带数据源名字的字段。
    const keys = Object.keys(got.get("tk_2") as object);
    expect(keys.some((k) => /cgk|coingecko|coin_?id|orphan|recheck/i.test(k))).toBe(false);
  });

  it("logo 回退链:源给的优先,没有就用连接器自带那张", async () => {
    const h = setup([
      info({ id: "tk_1", logo: "up.png", providerLogo: "p.png" }),
      info({ id: "tk_2", logo: undefined, providerLogo: "p.png" }),
      info({ id: "tk_3", logo: undefined }),
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect(yield* tokens.logoUrlById("tk_1")).toEqual(Option.some("up.png"));
        expect(yield* tokens.logoUrlById("tk_2")).toEqual(Option.some("p.png"));
        expect(yield* tokens.logoUrlById("tk_3")).toEqual(Option.none());
        expect(yield* tokens.logoUrlById("nope")).toEqual(Option.none());
      }),
    );
  });
});

describe("取价 —— 走同一个 SWR 编排", () => {
  it("新鲜 → 直接回,不碰上游", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: NOW }], PRICE_TTL_MS);
        expect(yield* tokens.priceOf("tk_1")).toEqual(
          Option.some(expect.objectContaining({ unitPrice: 60000, stale: false })),
        );
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("stale → 回源 → 写回(长尾币按需取价走这条)", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: 0 }], PRICE_TTL_MS);
        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        h.upstream.prices.set(SRC_BTC, { unitPrice: 61000, asOf: NOW });

        expect(Option.getOrThrow(yield* tokens.priceOf("tk_1"))).toMatchObject({
          unitPrice: 61000,
        });
        expect(h.upstream.calls).toEqual([`fetchPrices:${SRC_BTC}`]);
        expect(h.prices.current.get("tk_1")?.price.unitPrice).toBe(61000); // 写回了
      }),
    );
  });

  it("上游还没认出的币取不了价 —— 不问上游,把旧值原样给出去", async () => {
    const h = setup([info({ id: "tk_1", ref: null })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 42, asOf: 0 }], 0);
        expect(Option.getOrThrow(yield* tokens.priceOf("tk_1"))).toMatchObject({
          unitPrice: 42,
          stale: true,
        });
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("上游也没有 → 保留旧值(过期不删)", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: 0 }], 0);
        expect(Option.getOrThrow(yield* tokens.priceOf("tk_1"))).toMatchObject({
          unitPrice: 60000,
        });
        expect(h.prices.current.get("tk_1")?.price.unitPrice).toBe(60000);
      }),
    );
  });
});

describe("批量刷 stale 价", () => {
  it("只刷「认得出来且价 stale/缺失」的,一次批量回源", async () => {
    const h = setup([
      info({ id: "fresh" }),
      info({ id: "stale", ref: "src/issued:ethereum" }),
      info({ id: "nopricexyz", ref: "src/issued:tether" }),
      info({ id: "unknown", ref: null }), // 上游没认出 → 跳过
    ]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "fresh", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        yield* h.prices.put([{ tokenId: "stale", unitPrice: 1, asOf: 0 }], 0);
        h.upstream.prices.set("src/issued:ethereum", { unitPrice: 3000, asOf: NOW });
        h.upstream.prices.set("src/issued:tether", { unitPrice: 1, asOf: NOW });

        expect(
          (yield* tokens.refreshStale(["fresh", "stale", "nopricexyz", "unknown"])).prices,
        ).toBe(2);
        // 只断言价那半问了什么 —— 两半现在同一个方法里跑,info 那半的调用不属于这条用例。
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchPrices"))).toEqual([
          "fetchPrices:src/issued:ethereum,src/issued:tether",
        ]);
      }),
    );
  });

  it("没有要刷的 → 零调用", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        expect((yield* tokens.refreshStale(["tk_1"])).prices).toBe(0);
        expect(yield* tokens.refreshStale([])).toEqual({ prices: 0, infos: 0, degraded: false });
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  // 迁移前刷价**往外抛**、刷 info 内部吞 —— 于是每个调用点都得记得给前者补 `.catch(() => 0)`。
  // 现在是一个方法、一个口径:记一行、回 0,**而且把「挂了」写进返回值**(`degraded`)——
  // 「没什么要刷」与「上游挂了」对调用方是两件事(#375 要的抓手)。
  it("上游挂了 → 回 0 且 degraded、不抛", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])))).toEqual({
      prices: 0,
      infos: 0,
      degraded: true,
    });
    expect(h.prices.current.size).toBe(0);
  });

  it("没什么要刷 → degraded 是 false(与「挂了」分得开)", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_1", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        // info 也已刷过(`info()` 默认 infoStale: false)→ 两半都没有目标。
        expect(yield* tokens.refreshStale(["tk_1"])).toEqual({
          prices: 0,
          infos: 0,
          degraded: false,
        });
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  // 同一批 id **只读一次 store**:迁移前是两个方法各读一遍(而且调用点成对并发,连
  // 「第二次碰巧命中」都不存在)。这条断言就是那次合并的收据。
  it("价与 info 共用那两次读 —— store 读一次、价 store 读一次", async () => {
    const h = setup([info({ id: "tk_1", infoStale: true })]);
    let storeReads = 0;
    const realGetByIds = h.store.getByIds;
    h.store.getByIds = (ids) => {
      storeReads += 1;
      return realGetByIds(ids);
    };
    await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])));
    expect(storeReads).toBe(1);
  });
});

// 元信息(symbol/name/logo)的**覆盖**刷新。与刷价分开的理由是 TTL 一长一短(30d / 30min)。
//
// 为什么必须是覆盖:代币行是拿连接器报的元信息建起来的,而链上合约的 symbol 是部署者写在合约里的
// 字符串 —— 可能过时(MATIC 改名 POL 之后,链上那份还写着 MATIC)。合约那条 ref 是**按地址**
// 认出来的、认定本身可信,错的只是显示名。不覆盖的话同一个币会因为哪个账户先同步而显示成不同的名字。
describe("批量刷 stale 元信息(覆盖)", () => {
  it("只刷「认得出来且 info stale」的,一次批量回源", async () => {
    const h = setup([
      info({ id: "fresh" }), // 刷过了 → 跳过
      info({ id: "stale", ref: "src/issued:ethereum", infoStale: true }),
      info({ id: "unknown", ref: null, infoStale: true }), // 上游没认出 → 没名字可取,跳过
    ]);
    h.upstream.markets = [
      { ref: "src/issued:ethereum", symbol: "ETH", name: "Ethereum", logo: "eth.png" },
    ];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect((yield* tokens.refreshStale(["fresh", "stale", "unknown"])).infos).toBe(1);
        // 同上:只看 info 那半问了什么。
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchTokens"))).toEqual([
          "fetchTokens:src/issued:ethereum",
        ]);
        // 刷过之后不再 stale → 下一次零调用(否则每次访问都白刷一趟上游)。
        expect(h.store.rows.get("stale")?.infoStale).toBe(false);
        expect((yield* tokens.refreshStale(["fresh", "stale", "unknown"])).infos).toBe(0);
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchTokens"))).toEqual([
          "fetchTokens:src/issued:ethereum",
        ]);
      }),
    );
  });

  // **大小写是我们的展示口径,不是上游的。** CoinGecko 给的 symbol 是小写(`usdc`),而建行那一侧
  // 是大写 —— 不归一就出现「刷一次就变小写」:界面上从 `USDC` 跳成 `usdc`。而且 symbol 还是
  // symbol 消歧的比较键(candidatesBySymbol),两个写者对同一列口径必须一致。
  // 覆盖上游给的**名字**仍然是对的(MATIC→POL),那是内容;大小写不是内容。
  it("上游的 symbol 归一成大写才写(名字照抄,大小写不照抄)", async () => {
    const h = setup([
      info({ id: "t1", ref: "src/issued:usd-coin", symbol: "USDC", infoStale: true }),
    ]);
    h.upstream.markets = [
      { ref: "src/issued:usd-coin", symbol: "usdc", name: "USDC", logo: "usdc.png" },
    ];

    expect((await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["t1"])))).infos).toBe(1);
    expect(h.store.rows.get("t1")?.symbol).toBe("USDC");
    expect(h.store.rows.get("t1")?.name).toBe("USDC");
    expect(h.store.rows.get("t1")?.logo).toBe("usdc.png");
  });

  it("**链上 symbol 与上游不一致 → 上游那份赢**(MATIC→POL)", async () => {
    // 行是按合约地址认出来的(认定可信),但建行时拿的是合约里写的 symbol —— 那份是旧名。
    const h = setup([
      info({
        id: "tk_pol",
        ref: "src/issued:polygon-ecosystem-token",
        symbol: "MATIC",
        name: "Matic Network",
        providerLogo: "zerion-matic.png",
        infoStale: true,
      }),
    ]);
    h.upstream.markets = [
      {
        ref: "src/issued:polygon-ecosystem-token",
        symbol: "POL",
        name: "POL (ex-MATIC)",
        logo: "pol.png",
      },
    ];

    expect(
      (await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_pol"])))).infos,
    ).toBe(1);
    const row = h.store.rows.get("tk_pol");
    expect(row?.symbol).toBe("POL"); // 覆盖,不是填空槽
    expect(row?.name).toBe("POL (ex-MATIC)");
    expect(row?.logo).toBe("pol.png");
    // 连接器自带的备用图不动 —— 上游无权覆盖它(它是展示回退链的第二档)。
    expect(row?.providerLogo).toBe("zerion-matic.png");
  });

  it("上游这次没给图 → 保留原有的,别擦成空", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", logo: "old.png", infoStale: true })]);
    h.upstream.markets = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];

    await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])));
    expect(h.store.rows.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "old.png" });
  });

  it("上游挂了 → 什么都不写、不抛,行保留连接器那份", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", infoStale: true })]);
    h.upstream.fail = upstreamDown();

    expect((await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])))).infos).toBe(
      0,
    );
    expect(h.store.rows.get("tk_1")).toMatchObject({ symbol: "OLD", infoStale: true });
  });

  it("上游回了个映射不到 token 的 ref → 丢掉,不乱写", async () => {
    const h = setup([info({ id: "tk_1", symbol: "OLD", infoStale: true })]);
    h.upstream.fetchTokens = () =>
      Effect.succeed([{ ref: "src/issued:somebody-else", symbol: "ELSE", name: "Else" }]);

    expect((await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])))).infos).toBe(
      0,
    );
    expect(h.store.rows.get("tk_1")?.symbol).toBe("OLD");
  });

  it("没有要刷的 → 零调用", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect((yield* tokens.refreshStale(["tk_1"])).infos).toBe(0);
        expect((yield* tokens.refreshStale([])).infos).toBe(0);
        // info 那半没有目标 → 一次 `fetchTokens` 都不该发(价那半另有自己的用例)。
        expect(h.upstream.calls.filter((c) => c.startsWith("fetchTokens"))).toEqual([]);
      }),
    );
  });
});

describe("边角", () => {
  it("上游回了个映射不到 token 的 ref → 跳过,不写野行", async () => {
    const h = setup([info({ id: "tk_1" })]);
    // 上游多回了一条我们没问的(或已被合并掉的)ref。
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, asOf: NOW });
    h.upstream.prices.set("src/issued:stranger", { unitPrice: 1, asOf: NOW });

    expect((await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])))).prices).toBe(
      1,
    );
    expect([...h.prices.current.keys()]).toEqual(["tk_1"]);
  });

  it("有价但 info 行没了(合并删过)→ 富化不出这一行", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.put([{ tokenId: "tk_gone", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
        const got = yield* tokens.enrich(["tk_1", "tk_gone"]);
        expect([...got.keys()]).toEqual(["tk_1"]);
      }),
    );
  });
});

describe("历史日价(按 token_id)", () => {
  const day = (offset: number) => (TODAY + offset) * MS_PER_DAY;

  it("范围查:缓存命中的过去日直接用,缺的一次回源补齐并落缓存", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.series = [
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
    ];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 100 }]);

        expect(yield* tokens.priceSeries("tk_1", day(-3), day(-1))).toEqual([
          { atMs: day(-3), unitPrice: 100 },
          { atMs: day(-2), unitPrice: 200 },
          { atMs: day(-1), unitPrice: 300 },
        ]);
        // 补齐的两天永久落了缓存(过去日不可变)。
        expect(yield* h.prices.getDaily("tk_1", [TODAY - 2, TODAY - 1])).toEqual(
          new Map([
            [TODAY - 2, 200],
            [TODAY - 1, 300],
          ]),
        );
      }),
    );
  });

  it("全部命中缓存 → 不碰上游", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [
          { dayBucket: TODAY - 2, unitPrice: 1 },
          { dayBucket: TODAY - 1, unitPrice: 2 },
        ]);
        expect(yield* tokens.priceSeries("tk_1", day(-2), day(-1))).toHaveLength(2);
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("今日桶恒现取、不落缓存(它还会变)", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.series = [{ atMs: NOW, unitPrice: 999 }];
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect(yield* tokens.priceSeries("tk_1", day(0), NOW)).toEqual([
          { atMs: day(0), unitPrice: 999 },
        ]);
        expect(yield* h.prices.getDaily("tk_1", [TODAY])).toEqual(new Map());
        yield* tokens.priceSeries("tk_1", day(0), NOW);
        expect(h.upstream.calls).toHaveLength(2); // 第二次照样回源
      }),
    );
  });

  it("上游失败 → 退回仅缓存,不抛", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 2, unitPrice: 7 }]);
        expect(yield* tokens.priceSeries("tk_1", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 7 },
        ]);
      }),
    );
  });

  it("上游没认出的币 / 反向区间 → 空,不碰上游", async () => {
    const h = setup([info({ id: "unknown", ref: null }), info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect(yield* tokens.priceSeries("unknown", day(-2), day(-1))).toEqual([]);
        expect(yield* tokens.priceSeries("tk_1", day(-1), day(-2))).toEqual([]);
        expect(h.upstream.calls).toEqual([]);
      }),
    );
  });

  it("priceAt 取该 UTC 日桶的价;那天没数据 → none", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 5, unitPrice: 42 }]);
        expect(yield* tokens.priceAt("tk_1", day(-5) + 3_600_000)).toEqual(Option.some(42));
        expect(yield* tokens.priceAt("tk_1", day(-6))).toEqual(Option.none());
      }),
    );
  });

  // 桶是 epoch 起算的整日,与月/年边界无关 —— 跨月那一天不该有任何特殊行为。
  // (日历月边界曾经是这类实现的常见错处:按 `getMonth()` 分组会在月初错一格。)
  it("priceAt 跨月/跨年的那一天照常取,桶按 epoch 整日切", async () => {
    const h = setup([info({ id: "tk_1" })]);
    // 2023-12-31T23:00Z 与 2024-01-01T01:00Z —— 相邻两日,跨年。
    const lastDayOf2023 = Date.UTC(2023, 11, 31, 23, 0, 0);
    const firstDayOf2024 = Date.UTC(2024, 0, 1, 1, 0, 0);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [
          { dayBucket: dayBucketOf(lastDayOf2023), unitPrice: 100 },
          { dayBucket: dayBucketOf(firstDayOf2024), unitPrice: 200 },
        ]);

        expect(yield* tokens.priceAt("tk_1", lastDayOf2023)).toEqual(Option.some(100));
        expect(yield* tokens.priceAt("tk_1", firstDayOf2024)).toEqual(Option.some(200));
      }),
    );
    // 两个桶号确实相邻,没有因为跨年多出或少掉一格。
    expect(dayBucketOf(firstDayOf2024) - dayBucketOf(lastDayOf2023)).toBe(1);
  });

  it("priceAt 取的是**当日**的桶,不会把前一日的价当今天的", async () => {
    const h = setup([info({ id: "tk_1" })]);
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        yield* h.prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 7 }]);
        // 当日零点整(桶起点)也算当日。
        expect(yield* tokens.priceAt("tk_1", day(-3))).toEqual(Option.some(7));
        // 次日零点 → 已是下一个桶,当日无数据。
        expect(yield* tokens.priceAt("tk_1", day(-2))).toEqual(Option.none());
      }),
    );
  });
});

describe("选币的取价(按 ref,不建行)", () => {
  it("按 ref 现取 —— 库里既不多一行代币,也不多一条价缓存", async () => {
    const h = setup();
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, change24h: 1.5, asOf: NOW });

    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.priceByRef(SRC_BTC)))).toEqual(
      Option.some({ unitPrice: 60000, change24h: 1.5, asOf: NOW }),
    );
    // 这一刻用户只是在下拉里点了一下,还没提交 —— 什么都不该落库。
    expect(h.store.rows.size).toBe(0);
    expect(h.prices.current.size).toBe(0);
  });

  it("上游不认识这条 ref → none(表单让用户自己填)", async () => {
    const h = setup();
    expect(
      await h.run(Effect.flatMap(TokenReader, (t) => t.priceByRef("src/issued:nope"))),
    ).toEqual(Option.none());
  });

  it("上游挂了 → none,不抛 —— 取不到价不该把选币流程打断", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.priceByRef(SRC_BTC)))).toEqual(
      Option.none(),
    );
  });
});

describe("选币下拉的批量刷价(pricesByRefs,不建行)", () => {
  const SRC_ETH = "src/issued:ethereum";

  it("一批 ref 现取 —— 库里既不多代币行也不多价缓存", async () => {
    const h = setup();
    h.upstream.prices.set(SRC_BTC, { unitPrice: 60000, change24h: 1.5, asOf: NOW });
    h.upstream.prices.set(SRC_ETH, { unitPrice: 3000, change24h: -2, asOf: NOW });

    const got = await h.run(Effect.flatMap(TokenReader, (t) => t.pricesByRefs([SRC_BTC, SRC_ETH])));
    expect(got.get(SRC_BTC)).toEqual({ unitPrice: 60000, change24h: 1.5, asOf: NOW });
    expect(got.get(SRC_ETH)).toEqual({ unitPrice: 3000, change24h: -2, asOf: NOW });
    expect(h.store.rows.size).toBe(0);
    expect(h.prices.current.size).toBe(0);
  });

  it("空入参 → 空 Map,不出网", async () => {
    const h = setup();
    const got = await h.run(Effect.flatMap(TokenReader, (t) => t.pricesByRefs([])));
    expect(got.size).toBe(0);
    expect(h.upstream.calls).toEqual([]);
  });

  it("上游挂了 → 空 Map,不抛 —— 刷价失败不该把下拉打断", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    const got = await h.run(Effect.flatMap(TokenReader, (t) => t.pricesByRefs([SRC_BTC])));
    expect(got.size).toBe(0);
  });
});

describe("橱窗与候选", () => {
  const markets = [
    {
      ref: SRC_BTC,
      symbol: "BTC",
      name: "Bitcoin",
      price: { unitPrice: 60000, marketCapRank: 1, asOf: NOW },
    },
    {
      ref: "src/issued:tether",
      symbol: "USDT",
      name: "Tether",
      price: { unitPrice: 1, marketCapRank: 3, asOf: NOW },
    },
  ];

  it("排行榜走 warm(经 SWR 预热一次);候选与它同一份 rows", async () => {
    const h = setup();
    h.upstream.markets = markets;
    await h.run(
      Effect.gen(function* () {
        const tokens = yield* TokenReader;
        expect((yield* tokens.topTokens(1)).map((t) => t.ref)).toEqual([SRC_BTC]);
        expect(h.upstream.calls).toEqual(["fetchMarkets:1000"]);
        // 第二次从 blob 出,不再预热 —— 缓存里始终只有一个键。
        expect((yield* tokens.topTokens(2)).map((t) => t.ref)).toEqual([
          SRC_BTC,
          "src/issued:tether",
        ]);
        expect(h.upstream.calls).toHaveLength(1);
        expect([...h.cache.entries.keys()]).toEqual(["warm"]);
      }),
    );
  });

  it("要的比有的多 → 给全部,不补空位", async () => {
    const h = setup();
    h.upstream.markets = [markets[0]];
    const got = await h.run(Effect.flatMap(TokenReader, (t) => t.topTokens(50)));
    expect(got.map((t) => t.ref)).toEqual([SRC_BTC]);
    expect(got.every((t) => t !== undefined)).toBe(true);
  });

  it("预热失败不抛,返回空让调用方降级", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.topTokens(10)))).toEqual([]);
  });

  it("搜索恒回源(结果与用户无关)", async () => {
    const h = setup();
    h.upstream.searchResults = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];
    expect(await h.run(Effect.flatMap(TokenReader, (t) => t.search("bit")))).toHaveLength(1);
    expect(h.upstream.calls).toEqual(["searchTokens:bit"]);
  });

  // **搜索是唯一把上游错误交出去的方法**:它没有本地旧值可退,吞掉只会让用户看着空列表
  // 以为「搜不到这个币」。调用方(server fn)自己决定怎么显示。
  it("搜索失败 → 错误交给调用方,不当成「没搜到」", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    const result = await h.run(Effect.either(Effect.flatMap(TokenReader, (t) => t.search("bit"))));
    expect(result._tag).toBe("Left");
  });
});

// 迁移前这 6 处降级是 `catch {}`,**一行日志都没有**:上游整晚限流,只有用户看到旧价。
describe("降级要留痕", () => {
  it("上游挂了 → 有一条 warning,带 tag / pathname / 状态码,而且不带 query", async () => {
    const h = setup([info({ id: "tk_1" })]);
    h.upstream.fail = upstreamDown();
    await h.run(Effect.flatMap(TokenReader, (t) => t.refreshStale(["tk_1"])));

    const warn = h.logs.find((l) => l.level === "WARN");
    expect(warn?.message).toContain("upstream fetch failed");
    expect(warn?.annotations).toMatchObject({
      at: "tokens.refreshStale.prices",
      error: "UpstreamUnavailableError",
      where: "/fake",
      status: 503,
    });
    // 原则 #5:`where` 是 pathname,不可能带上 key / 签名 / 地址。
    expect(JSON.stringify(warn?.annotations)).not.toContain("?");
  });
});
