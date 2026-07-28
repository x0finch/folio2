import { describe, expect, it } from "vitest";
import type { UpstreamToken } from "../src";
import {
  cacheKeys,
  candidatesBySymbol,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  pickByConfidence,
  readFx,
  readPlatforms,
  refreshCatalogue,
  topByRank,
  WARM_TTL_MS,
  warmCatalogue,
  warmMarkets,
  writeFx,
  writePlatforms,
} from "../src";
import { fakeCacheStore, fakeUpstream } from "./fakes";

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/issued:${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

describe("三种键", () => {
  it("只有 warm / fx:<币种> / platform:<键> 三种", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];

    await warmMarkets(cache, upstream, 10, cache.now);
    await writeFx(cache, [{ currency: "eur", usdPerUnit: 1.08 }]);
    await writePlatforms(cache, [{ key: "evm:1", entry: { name: "Ethereum", logo: "e.png" } }]);

    expect([...cache.entries.keys()].sort()).toEqual(["fx:EUR", "platform:evm:1", "warm"]);
    expect(cacheKeys.fx(" eur ")).toBe("fx:EUR"); // 键归一在造键那一处
  });

  it("读回:汇率是数、平台是 {name, logo};miss 的键不出现", async () => {
    const cache = fakeCacheStore();
    await writeFx(cache, [{ currency: "EUR", usdPerUnit: 1.08 }]);
    await writePlatforms(cache, [
      { key: "bitcoin", entry: { name: "Bitcoin" } },
      // 否定缓存(`name: null`)与「没这条」是两件事 —— 读得出来,只是没有名字。
      { key: "nochain", entry: { name: null } },
    ]);

    expect(await readFx(cache, "eur")).toBe(1.08);
    expect(await readFx(cache, "JPY")).toBeUndefined();

    const hits = await readPlatforms(cache, ["bitcoin", "nochain", "nope"]);
    expect(hits.get("bitcoin")?.entry).toEqual({ name: "Bitcoin" });
    expect(hits.get("nochain")?.entry).toEqual({ name: null });
    expect(hits.has("nope")).toBe(false);
  });

  it("批量读一次往返、批量写一个批次 —— 逐键往返会把总览的 1 次 D1 变成 N 次", async () => {
    const cache = fakeCacheStore();
    await writeFx(cache, [
      { currency: "EUR", usdPerUnit: 1.08 },
      { currency: "JPY", usdPerUnit: 0.0067 },
      { currency: "GBP", usdPerUnit: 1.27 },
    ]);
    expect(cache.writes).toBe(1); // 三个币种,一个批次

    const before = cache.reads;
    await readPlatforms(cache, ["evm:1", "solana", "bitcoin"]);
    expect(cache.reads - before).toBe(1); // 三个键,一次读
  });

  it("TTL:warm 按**目录**的寿命盖戳,不再按价(#216)", async () => {
    const cache = fakeCacheStore();
    await warmMarkets(cache, fakeUpstream(), 10, cache.now);
    await writePlatforms(cache, [{ key: "evm:1", entry: { name: "Ethereum" } }]);

    expect(cache.entries.get("warm")?.expiresAt).toBe(cache.now + WARM_TTL_MS);
    expect(cache.entries.get("platform:evm:1")?.expiresAt).toBe(cache.now + PLATFORM_TTL_MS);
    // 目录与「链/场馆的名与图」同一量级(都近静态),都远长于价。
    expect(WARM_TTL_MS).toBeGreaterThan(PRICE_TTL_MS * 10);
  });
});

describe("warm 走 SWR,一次整份写", () => {
  it("三个币一次写;没过期就不拉上游", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [
      coin("bitcoin", "BTC", 1),
      coin("ethereum", "ETH", 2),
      coin("tether", "USDT", 3),
    ];

    expect(await warmMarkets(cache, upstream, 50, cache.now)).toHaveLength(3);
    expect(cache.writes).toBe(1); // 三个币,一次写
    expect(cache.entries.size).toBe(1);

    await warmMarkets(cache, upstream, 50, cache.now);
    expect(upstream.calls).toEqual(["fetchMarkets:50"]); // 只拉过一次
  });

  it("橱窗:**价**旧了才重拉 —— 判据是 blob 的 asOf,不是缓存条目的过期戳", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmMarkets(cache, upstream, 50, cache.now);

    cache.now += PRICE_TTL_MS + 1; // 远早于 WARM_TTL_MS(24h),条目本身还没过期
    await warmMarkets(cache, upstream, 50, cache.now);
    expect(upstream.calls).toHaveLength(2);
  });

  it("上游挂了 → 给旧的那份,不抛(SWR 兜的)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmMarkets(cache, upstream, 50, cache.now);

    cache.now += PRICE_TTL_MS + 1;
    upstream.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await warmMarkets(cache, upstream, 50, cache.now)).toHaveLength(1);
  });
});

// 同一份 blob 的另一个读者。**它在写路径上**(mint 的 symbol 那一档),所以判据完全不同:
// 有就用,多旧都用。这是 #216 的核心 —— 不让「哪个币叫 POL」这种几乎不变的数据把用户
// 卡在 4 次目录请求上。
describe("目录读者:有就用,只有完全没有才取一次", () => {
  it("blob 再旧也不回源 —— 隔了一年照样零请求", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmCatalogue(cache, upstream, 50, cache.now); // 冷 → 取一次

    cache.now += 365 * 24 * 60 * 60 * 1000;
    expect(await warmCatalogue(cache, upstream, 50, cache.now)).toHaveLength(1);
    expect(upstream.calls).toEqual(["fetchMarkets:50"]); // 仍然只有那一次
  });

  it("完全没有 → 取一次(躲不掉:候选集为空 = 按 symbol 认的币全认不出来)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];

    expect(await warmCatalogue(cache, upstream, 50, cache.now)).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
  });

  it("橱窗刷过之后,目录读者读到的是新的那份(同一个键,不是两份缓存)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmCatalogue(cache, upstream, 50, cache.now);

    cache.now += PRICE_TTL_MS + 1;
    upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
    await warmMarkets(cache, upstream, 50, cache.now); // 用户打开下拉 → 刷

    expect(await warmCatalogue(cache, upstream, 50, cache.now)).toHaveLength(2);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("上游冷启动就挂了 → 空候选,不抛(认不出来总好过同步崩)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await warmCatalogue(cache, upstream, 50, cache.now)).toEqual([]);
  });
});

// 第三个读者:同步之后在后台跑。没有它,不打开选币下拉的用户目录会永远冻在第一次同步那一刻。
describe("后台预热:目录旧了才刷", () => {
  it("一周之内 → 零请求(绝大多数同步落在这里)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await refreshCatalogue(cache, upstream, 50, cache.now);

    cache.now += WARM_TTL_MS - 1;
    await refreshCatalogue(cache, upstream, 50, cache.now);
    expect(upstream.calls).toHaveLength(1);
  });

  it("超过一周 → 整份刷一次", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await refreshCatalogue(cache, upstream, 50, cache.now);

    cache.now += WARM_TTL_MS + 1;
    upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
    expect(await refreshCatalogue(cache, upstream, 50, cache.now)).toHaveLength(2);
    expect(upstream.calls).toHaveLength(2);
  });

  it("刷完之后 mint 的候选源立刻看得到新币 —— 这才是它存在的理由", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmCatalogue(cache, upstream, 50, cache.now); // 第一次同步建起来的那份

    cache.now += WARM_TTL_MS + 1;
    upstream.markets = [coin("bitcoin", "BTC", 1), coin("newcoin", "NEW", 900)];
    await refreshCatalogue(cache, upstream, 50, cache.now); // 后台预热

    const rows = await warmCatalogue(cache, upstream, 50, cache.now);
    expect(candidatesBySymbol(rows, "NEW")).toEqual([
      { ref: "src/issued:newcoin", marketCapRank: 900 },
    ]);
  });

  it("后台刷挂了 → 给旧的那份,不抛(它在 waitUntil 里,不该让同步收尾炸掉)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await refreshCatalogue(cache, upstream, 50, cache.now);

    cache.now += WARM_TTL_MS + 1;
    upstream.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await refreshCatalogue(cache, upstream, 50, cache.now)).toHaveLength(1);
  });
});

describe("排行榜与 symbol 候选出自同一份 rows", () => {
  it("取前 N 名按市值升序,无 rank 者垫底", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [
      coin("tether", "USDT", 3),
      coin("nameless", "XXX"),
      coin("bitcoin", "BTC", 1),
    ];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);

    expect(topByRank(rows, 2).map((r) => r.info.ref)).toEqual([
      "src/issued:bitcoin",
      "src/issued:tether",
    ]);
    expect(topByRank(rows, 9).at(-1)?.info.ref).toBe("src/issued:nameless");
  });

  it("按 symbol 取候选不额外存一份 —— 缓存里仍只有一个键", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);

    expect(candidatesBySymbol(rows, "usdc")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
      { ref: "src/issued:fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("symbol 归一同口径(大小写/空白不影响命中)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "btc", 1)];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);
    expect(candidatesBySymbol(rows, "  BTC ")).toEqual([
      { ref: "src/issued:bitcoin", marketCapRank: 1 },
    ]);
  });

  // 目录里混进同一个币两次(上游分页来自不同快照,见 coingecko adapter)。**不去重的后果是
  // 静默的**:消歧会拿这个币跟它自己比,谁也碾压不了谁 → 判定没把握 → 这个币从此认不出来,
  // 表现只是「那个持仓没有实时价」。所以读这一侧再兜一道,不只指望上游。
  it("同一个币在目录里出现两次 → 候选只留一条", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("usd-coin", "USDC", 6), coin("usd-coin", "USDC", 6)];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);

    expect(candidatesBySymbol(rows, "USDC")).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
    ]);
  });

  // 去重必须在**读**这一侧,不能只在上游那侧:修好之前存下的脏目录还躺在缓存里,而这份 blob
  // 一周才刷一次 —— 只修上游的话,已经中招的用户还要再脏一周。
  it("缓存里已经是脏的 → 读出来就是干净的,且不为此回一趟上游", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    const row = { info: { ref: "src/issued:usd-coin", symbol: "USDC", name: "USDC" }, price: {} };
    await cache.put(cacheKeys.warm, { asOf: cache.now, rows: [row, row] }, WARM_TTL_MS);

    const rows = await warmMarkets(cache, upstream, 50, cache.now);
    expect(rows).toHaveLength(1);
    expect(upstream.calls).toEqual([]); // 治脏数据不该换来一次回源
  });

  it("重复的币照样认得出来 —— 不去重的话它会输给自己", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    // 排名 592:够不上「前 50 直接信」,只能靠碾压次席。自己跟自己比 = 比值 1 → 认不出来。
    upstream.markets = [
      coin("collector-crypt", "CARDS", 592),
      coin("collector-crypt", "CARDS", 592),
    ];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);

    expect(pickByConfidence(candidatesBySymbol(rows, "CARDS"))).toBe("src/issued:collector-crypt");
  });
});

describe("整张清空", () => {
  it("功能不坏,下一次访问自己填回来", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "BTC", 1)];
    await warmMarkets(cache, upstream, 50, cache.now);

    cache.entries.clear();
    expect(await readFx(cache, "EUR")).toBeUndefined();
    expect(await warmMarkets(cache, upstream, 50, cache.now)).toHaveLength(1);
    expect(upstream.calls).toHaveLength(2);
  });
});
