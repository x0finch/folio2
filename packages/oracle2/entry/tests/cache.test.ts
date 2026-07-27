import { describe, expect, it } from "vitest";
import type { UpstreamToken } from "../src";
import {
  cacheKeys,
  candidatesBySymbol,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  readFx,
  readPlatform,
  refreshCatalogue,
  topByRank,
  WARM_TTL_MS,
  warmCatalogue,
  warmMarkets,
  writeFx,
  writePlatform,
} from "../src";
import { fakeCacheStore, fakeUpstream } from "./fakes";

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/${id}`,
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
    await writeFx(cache, "eur", 1.08);
    await writePlatform(cache, "evm:1", { name: "Ethereum", logo: "e.png" });

    expect([...cache.entries.keys()].sort()).toEqual(["fx:EUR", "platform:evm:1", "warm"]);
    expect(cacheKeys.fx(" eur ")).toBe("fx:EUR"); // 键归一在造键那一处
  });

  it("读回:汇率是数、平台是 {name, logo}", async () => {
    const cache = fakeCacheStore();
    await writeFx(cache, "EUR", 1.08);
    await writePlatform(cache, "bitcoin", { name: "Bitcoin" });

    expect(await readFx(cache, "eur")).toBe(1.08);
    expect(await readPlatform(cache, "bitcoin")).toEqual({ name: "Bitcoin" });
    expect(await readFx(cache, "JPY")).toBeUndefined();
    expect(await readPlatform(cache, "nope")).toBeUndefined();
  });

  it("TTL:warm 按**目录**的寿命盖戳,不再按价(#216)", async () => {
    const cache = fakeCacheStore();
    await warmMarkets(cache, fakeUpstream(), 10, cache.now);
    await writePlatform(cache, "evm:1", { name: "Ethereum" });

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
    expect(candidatesBySymbol(rows, "NEW")).toEqual([{ ref: "src/newcoin", marketCapRank: 900 }]);
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

    expect(topByRank(rows, 2).map((r) => r.info.ref)).toEqual(["src/bitcoin", "src/tether"]);
    expect(topByRank(rows, 9).at(-1)?.info.ref).toBe("src/nameless");
  });

  it("按 symbol 取候选不额外存一份 —— 缓存里仍只有一个键", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);

    expect(candidatesBySymbol(rows, "usdc")).toEqual([
      { ref: "src/usd-coin", marketCapRank: 6 },
      { ref: "src/fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("symbol 归一同口径(大小写/空白不影响命中)", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeUpstream();
    upstream.markets = [coin("bitcoin", "btc", 1)];
    const rows = await warmMarkets(cache, upstream, 50, cache.now);
    expect(candidatesBySymbol(rows, "  BTC ")).toEqual([{ ref: "src/bitcoin", marketCapRank: 1 }]);
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
