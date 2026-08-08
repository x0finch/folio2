import type { UpstreamToken } from "@folio/oracle-basic";
import { PRICE_TTL_MS, WARM_TTL_MS } from "@folio/oracle-basic";
import { Duration, Effect, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { candidatesBySymbol, warmCatalogue } from "../src/tokens/candidates";
import { refreshWarmCatalogue, topByRank, warmMarkets } from "../src/tokens/catalogue";
import { pickByConfidence } from "../src/tokens/confidence";
import { WARM_KEY } from "../src/tokens/warm";
import { harness, now0, upstreamDown } from "./fakes";

// 测的是 warm blob 这一件事:一张 per-user 缓存表上的 `warm` 键,**三个读者共用一份**。
// 直接 import `../src/*` 并把假端口当参数传进去 —— 这些函数的 `R` 是 `never`,
// 这正是「服务的依赖不外泄」的那个设计。
//
// 三个读者住在用它们的文件里(`warmMarkets` / `refreshWarmCatalogue` 在 tokens,
// `warmCatalogue` 在 candidates),但判据是一组对照关系,所以一起测。

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/issued:${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

const setup = (markets: UpstreamToken[] = []) => {
  const h = harness();
  h.upstream.markets = markets;
  return h;
};

describe("warm 走 SWR,一次整份写", () => {
  it("三个币一次写;没过期就不拉上游", async () => {
    const h = setup([
      coin("bitcoin", "BTC", 1),
      coin("ethereum", "ETH", 2),
      coin("tether", "USDT", 3),
    ]);
    await h.run(
      Effect.gen(function* () {
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(3);
        expect(h.cache.writes).toBe(1); // 三个币,一次写
        expect(h.cache.entries.size).toBe(1);

        yield* warmMarkets(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toEqual(["fetchMarkets:50"]); // 只拉过一次
      }),
    );
  });

  it("TTL 按**目录**的寿命盖戳,不按价(#216)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(warmMarkets(h.cache, h.upstream, 10));

    expect(h.cache.entries.get(WARM_KEY)?.expiresAt).toBe(now0 + WARM_TTL_MS);
    // 目录与「链/场馆的名与图」同一量级(都近静态),都远长于价。
    expect(WARM_TTL_MS).toBeGreaterThan(PRICE_TTL_MS * 10);
  });

  it("橱窗:**价**旧了才重拉 —— 判据是 blob 的 asOf,不是缓存条目的过期戳", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);
        // 远早于 WARM_TTL_MS(一周),条目本身还没过期
        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        yield* warmMarkets(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });

  it("上游挂了 → 给旧的那份,不抛(SWR 兜的)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        h.upstream.fail = upstreamDown();
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(1);
      }),
    );
  });
});

// 同一份 blob 的另一个读者。**它在写路径上**(mint 的 symbol 那一档),所以判据完全不同:
// 有就用,多旧都用。这是 #216 的核心 —— 不让「哪个币叫 POL」这种几乎不变的数据把用户
// 卡在 4 次目录请求上。
describe("目录读者:有就用,只有完全没有才取一次", () => {
  it("blob 再旧也不回源 —— 隔了一年照样零请求", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmCatalogue(h.cache, h.upstream, 50); // 冷 → 取一次
        yield* TestClock.adjust(Duration.millis(365 * 24 * 60 * 60 * 1000));
        expect(yield* warmCatalogue(h.cache, h.upstream, 50)).toHaveLength(1);
        expect(h.upstream.calls).toEqual(["fetchMarkets:50"]); // 仍然只有那一次
      }),
    );
  });

  it("完全没有 → 取一次(躲不掉:候选集为空 = 按 symbol 认的币全认不出来)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        expect(yield* warmCatalogue(h.cache, h.upstream, 50)).toHaveLength(1);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });

  it("橱窗刷过之后,目录读者读到的是新的那份(同一个键,不是两份缓存)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmCatalogue(h.cache, h.upstream, 50);

        yield* TestClock.adjust(Duration.millis(PRICE_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        yield* warmMarkets(h.cache, h.upstream, 50); // 用户打开下拉 → 刷

        expect(yield* warmCatalogue(h.cache, h.upstream, 50)).toHaveLength(2);
        expect([...h.cache.entries.keys()]).toEqual(["warm"]);
      }),
    );
  });

  it("上游冷启动就挂了 → 空候选,不抛(认不出来总好过同步崩)", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(warmCatalogue(h.cache, h.upstream, 50))).toEqual([]);
  });
});

// 第三个读者:同步之后在后台跑。没有它,不打开选币下拉的用户目录会永远冻在第一次同步那一刻。
describe("后台预热:目录旧了才刷", () => {
  it("一周之内 → 零请求(绝大多数同步落在这里)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS - 1));
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });

  it("超过一周 → 整份刷一次", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        expect(yield* refreshWarmCatalogue(h.cache, h.upstream, 50)).toHaveLength(2);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });

  it("刷完之后 mint 的候选源立刻看得到新币 —— 这才是它存在的理由", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmCatalogue(h.cache, h.upstream, 50); // 第一次同步建起来的那份

        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50); // 后台预热

        const rows = yield* warmCatalogue(h.cache, h.upstream, 50);
        expect(candidatesBySymbol(rows, "NEW")).toEqual([
          { ref: "src/issued:newcoin", marketCapRank: 900 },
        ]);
      }),
    );
  });

  it("后台刷挂了 → 给旧的那份,不抛(它在 waitUntil 里,不该让同步收尾炸掉)", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* refreshWarmCatalogue(h.cache, h.upstream, 50);
        yield* TestClock.adjust(Duration.millis(WARM_TTL_MS + 1));
        h.upstream.fail = upstreamDown();
        expect(yield* refreshWarmCatalogue(h.cache, h.upstream, 50)).toHaveLength(1);
      }),
    );
  });
});

describe("排行榜与 symbol 候选出自同一份 rows", () => {
  it("取前 N 名按市值升序,无 rank 者垫底", async () => {
    const h = setup([
      coin("tether", "USDT", 3),
      coin("nameless", "XXX"),
      coin("bitcoin", "BTC", 1),
    ]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(topByRank(rows, 2).map((r) => r.info.ref)).toEqual([
      "src/issued:bitcoin",
      "src/issued:tether",
    ]);
    expect(topByRank(rows, 9).at(-1)?.info.ref).toBe("src/issued:nameless");
  });

  it("按 symbol 取候选不额外存一份 —— 缓存里仍只有一个键", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(candidatesBySymbol(rows, "usdc")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
      { ref: "src/issued:fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...h.cache.entries.keys()]).toEqual(["warm"]);
  });

  it("symbol 归一同口径(大小写/空白不影响命中)", async () => {
    const h = setup([coin("bitcoin", "btc", 1)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));
    expect(candidatesBySymbol(rows, "  BTC ")).toEqual([
      { ref: "src/issued:bitcoin", marketCapRank: 1 },
    ]);
  });

  // 目录里混进同一个币两次(上游分页来自不同快照,见 coingecko adapter)。**不去重的后果是
  // 静默的**:消歧会拿这个币跟它自己比,谁也碾压不了谁 → 判定没把握 → 这个币从此认不出来,
  // 表现只是「那个持仓没有实时价」。所以读这一侧再兜一道,不只指望上游。
  it("同一个币在目录里出现两次 → 候选只留一条", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("usd-coin", "USDC", 6)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(candidatesBySymbol(rows, "USDC")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
    ]);
  });

  // 去重必须在**读**这一侧,不能只在上游那侧:修好之前存下的脏目录还躺在缓存里,而这份 blob
  // 一周才刷一次 —— 只修上游的话,已经中招的用户还要再脏一周。
  it("缓存里已经是脏的 → 读出来就是干净的,且不为此回一趟上游", async () => {
    const h = setup();
    const row = {
      info: { ref: "src/issued:usd-coin", symbol: "USDC", name: "USDC" },
      price: { unitPrice: 1, asOf: now0 },
    };
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(WARM_KEY, { asOf: now0, rows: [row, row] }, WARM_TTL_MS);
        const rows = yield* warmMarkets(h.cache, h.upstream, 50);
        expect(rows).toHaveLength(1);
        expect(h.upstream.calls).toEqual([]); // 治脏数据不该换来一次回源
      }),
    );
  });

  it("重复的币照样认得出来 —— 不去重的话它会输给自己", async () => {
    // 排名 592:够不上「前 50 直接信」,只能靠碾压次席。自己跟自己比 = 比值 1 → 认不出来。
    const h = setup([coin("collector-crypt", "CARDS", 592), coin("collector-crypt", "CARDS", 592)]);
    const rows = await h.run(warmMarkets(h.cache, h.upstream, 50));

    expect(pickByConfidence(candidatesBySymbol(rows, "CARDS"))).toBe("src/issued:collector-crypt");
  });
});

// 缓存里躺着的可能是**上一个版本写的形状**(或者手动改过库)。迁移前这里是 `as WarmBlob` 加两处
// 手写形状检查,漏掉的字段会一路流到展示层;现在整份走 Schema 解码,解不动就当没有 → 回源重写。
describe("旧形状 / 坏形状 = miss,自愈", () => {
  it("blob 缺字段 → 当没缓存,回源写一份新的", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        // 少了 `price.asOf` —— 老代码的 `Array.isArray(rows)` 检查放它过关。
        yield* h.cache.put(
          WARM_KEY,
          {
            asOf: now0,
            rows: [{ info: { ref: "src/issued:x", symbol: "X", name: "X" }, price: {} }],
          },
          WARM_TTL_MS,
        );
        const rows = yield* warmCatalogue(h.cache, h.upstream, 50);
        expect(rows.map((r) => r.info.ref)).toEqual(["src/issued:bitcoin"]);
        expect(h.upstream.calls).toHaveLength(1);
      }),
    );
  });
});

describe("整张清空", () => {
  it("功能不坏,下一次访问自己填回来", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* warmMarkets(h.cache, h.upstream, 50);

        h.cache.entries.clear();
        expect(yield* warmMarkets(h.cache, h.upstream, 50)).toHaveLength(1);
        expect(h.upstream.calls).toHaveLength(2);
      }),
    );
  });
});
