import type { AssetPlatform, MarketCoin } from "@folio/coingecko-client";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinGeckoUpstream, UPSTREAM_ID } from "../src";

// 限速闸:每个用例从干净状态出发,且 sleep 即时 —— 否则无 key 档(10 次/分钟)会让这套测试
// **真的等**,而上一个用例撞出来的冷却还会漏给下一个。生产不传 sleep(用 setTimeout)。
const NO_WAIT = { sleep: async () => {} };
// 限速闸旁路:这个文件测的不是限频。闸的行为在 @folio/shared 的单测里用假时钟验过,
// 这里让它直接放行 —— 否则每个用例都要按窗口真等。
bypassRateLimitsForTests(true);

beforeEach(() => resetRateLimitsForTests());

// 单页上限不进导出面(调用方不需要知道分页存在),测分页边界要从常量模块直接取。
import { MARKETS_PER_PAGE } from "../src/constants";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };

// 把 `parse.ts` / `ref-index.ts` 的纯转换串成真上游的那一层:分页、链标识翻译、平台表记忆。
// 这里打的桩是**全局 fetch**(与 client 自己的测试同法),所以顺带钉住 upstream 究竟问了哪个
// 端点、带了什么参数 —— 换成注入假 client 就看不见这一截了。

const PLATFORMS = assetPlatforms as AssetPlatform[];

interface Call {
  path: string;
  query: URLSearchParams;
}

// 按路径路由的 fetch 桩。`routes` 的键是路径片段;值可以是响应体,或抛错的哨兵。
function stubFetch(routes: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: url.searchParams });
    const key = Object.keys(routes).find((k) => url.pathname.includes(k));
    if (key === undefined) throw new Error(`未打桩的端点: ${url.pathname}`);
    const hit = routes[key];
    const body = typeof hit === "function" ? (hit as () => unknown)() : hit;
    // 哨兵:抛的 Error 的 message 是想要的状态码(默认 429)。**429 和 5xx 不等价** ——
    // 前者除了失败还会让 client 进冷却,后者只是失败。
    if (body instanceof Error) return new Response(null, { status: Number(body.message) || 429 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const marketRow = (id: string, rank: number): MarketCoin =>
  ({
    id,
    symbol: id.slice(0, 4),
    name: id,
    current_price: 1,
    market_cap_rank: rank,
  }) as MarketCoin;

// 第 n 页:币的 id 按页错开,否则两页拿到的是同一批币 —— 那正是「翻页去重」要测的东西,
// 用同一批币当夹具会让去重和不去重看起来一样。
const page = (count: number, pageNo = 1) =>
  Array.from({ length: count }, (_, i) => {
    const at = (pageNo - 1) * MARKETS_PER_PAGE + i;
    return marketRow(`coin-${at}`, at + 1);
  }) as MarketCoin[];

afterEach(() => vi.restoreAllMocks());

describe("自报标识", () => {
  it("id 就是本 adapter 的常量 —— 服务层拿它当 ref 的命名者", () => {
    expect(createCoinGeckoUpstream(NO_WAIT).id).toBe(UPSTREAM_ID);
  });
});

describe("fetchMarkets 分页", () => {
  it("topN 跨页 → 逐页取,页码递增,末尾裁到 topN", async () => {
    let n = 0;
    const calls = stubFetch({ "/coins/markets": () => page(MARKETS_PER_PAGE, ++n) });
    const rows = await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({
      topN: MARKETS_PER_PAGE + 10,
    });

    expect(calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(calls[0].query.get("per_page")).toBe(String(MARKETS_PER_PAGE));
    // 两页各 250 行,但只要 260 → 裁掉多的。
    expect(rows).toHaveLength(MARKETS_PER_PAGE + 10);
  });

  it("单页装得下 → 只请求一次", async () => {
    const calls = stubFetch({ "/coins/markets": () => page(10) });
    expect(await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({ topN: 10 })).toHaveLength(10);
    expect(calls).toHaveLength(1);
  });

  // 上游币数少于要的:不足一页就说明没有下一页了,继续问只是白白多一次 429 的机会。
  it("上游给不满一页 → 提前收手,不问下一页", async () => {
    const calls = stubFetch({ "/coins/markets": () => page(3) });
    const rows = await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({
      topN: MARKETS_PER_PAGE * 3,
    });

    expect(calls).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it("topN 小于一页也至少问一次(不产出 0 页)", async () => {
    const calls = stubFetch({ "/coins/markets": () => page(1) });
    await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({ topN: 0 });
    expect(calls).toHaveLength(1);
  });
});

// CoinGecko 的分页不是同一份榜单切出来的:一次抓取里前两页盖着同一个 last_updated、第三页更新过,
// 而排序按市值 —— 流通量在两份数据之间被修正过的币,会在旧那份里排进前面一页、新那份里又排进后面
// 一页。实测 1000 条里 43 个币这样重复。这几条钉的是「拼页时必须去重」。
describe("fetchMarkets 跨页重复(上游分页来自不同快照)", () => {
  // 第 1 页的最后一个币,在第 2 页又出现一次(市值被修正 → 排到了后面)。
  const overlapping = (pageNo: number): MarketCoin[] => {
    const rows = page(MARKETS_PER_PAGE, pageNo);
    if (pageNo === 2) rows[0] = marketRow("coin-249", 250); // 与第 1 页末尾同一个币
    return rows;
  };

  it("同一个币出现在两页 → 只留一条", async () => {
    let n = 0;
    stubFetch({ "/coins/markets": () => overlapping(++n) });
    const rows = await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({
      topN: MARKETS_PER_PAGE * 2,
    });

    const refs = rows.map((r) => r.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("留下的是**先出现**的那条 —— 它排得更靠前", async () => {
    let n = 0;
    stubFetch({ "/coins/markets": () => overlapping(++n) });
    const rows = await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({
      topN: MARKETS_PER_PAGE * 2,
    });

    const dup = rows.filter((r) => r.ref === `${UPSTREAM_ID}/issued:coin-249`);
    expect(dup).toHaveLength(1);
    // 第 1 页给的排名是 250;第 2 页那条也是 250,但位置在第 1 页 —— 取的是先来的。
    expect(rows.indexOf(dup[0])).toBe(MARKETS_PER_PAGE - 1);
  });

  // 去重之后就是会少于 topN。补齐要多翻页,而多翻的那页照样会撞重复 —— 补不出保证,
  // 少的又都在榜尾最不稳的一段。所以 topN 的意思是「往下抓多深」,不是「保证这么多个币」。
  it("去重后不足 topN → 就是不足,不再多翻页去补", async () => {
    let n = 0;
    const calls = stubFetch({ "/coins/markets": () => overlapping(++n) });
    const rows = await createCoinGeckoUpstream(NO_WAIT).fetchMarkets({
      topN: MARKETS_PER_PAGE * 2,
    });

    expect(rows).toHaveLength(MARKETS_PER_PAGE * 2 - 1);
    expect(calls).toHaveLength(2); // 没有第 3 页
  });
});

describe("链标识 → CoinGecko 的 asset_platform", () => {
  const CONTRACT = { "/contract/": { id: "usd-coin", symbol: "usdc", name: "USD Coin" } };

  it("EVM 靠数字 chainId 对齐(比 slug 可靠)", async () => {
    const calls = stubFetch({ "/asset_platforms": PLATFORMS, ...CONTRACT });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchByContract("42161", "0xAF88");

    expect(got?.symbol).toBe("usdc");
    // 42161 → arbitrum-one,而不是把 "42161" 当 slug 塞进 URL。
    expect(calls.some((c) => c.path.includes("/coins/arbitrum-one/contract/"))).toBe(true);
  });

  it("非 EVM 给 slug,大小写不敏感", async () => {
    const calls = stubFetch({ "/asset_platforms": PLATFORMS, ...CONTRACT });
    await createCoinGeckoUpstream(NO_WAIT).fetchByContract("Solana", "EPjF");
    expect(calls.some((c) => c.path.includes("/coins/solana/contract/"))).toBe(true);
  });

  // 对不上就别猜着拼 URL —— 那会换来一个 404,读起来像「这个币不存在」。
  it("平台表里没有这条链 → null,连合约端点都不问", async () => {
    const calls = stubFetch({ "/asset_platforms": PLATFORMS, ...CONTRACT });
    expect(await createCoinGeckoUpstream(NO_WAIT).fetchByContract("evm:99999", "0xabc")).toBeNull();
    expect(calls.some((c) => c.path.includes("/contract/"))).toBe(false);
  });

  it("缺 id 的平台条目跳过,不落一个 undefined 键", async () => {
    const calls = stubFetch({ "/asset_platforms": PLATFORMS, ...CONTRACT });
    expect(await createCoinGeckoUpstream(NO_WAIT).fetchByContract("999", "0xabc")).toBeNull();
    expect(calls.some((c) => c.path.includes("/contract/"))).toBe(false);
  });
});

describe("平台表记忆", () => {
  it("一次 sync 里连查几个合约只拉一次平台表", async () => {
    const calls = stubFetch({
      "/asset_platforms": PLATFORMS,
      "/contract/": { id: "usd-coin", symbol: "usdc", name: "USD Coin" },
    });
    const upstream = createCoinGeckoUpstream(NO_WAIT);
    await upstream.fetchByContract("1", "0xa0b8");
    await upstream.fetchByContract("42161", "0xaf88");

    expect(calls.filter((c) => c.path.includes("/asset_platforms"))).toHaveLength(1);
  });

  // **失败不进记忆。** 裸 `??=` 会把被拒绝的 promise 也存进槽里:Workers 的 isolate 跨请求
  // 存活,一次瞬时 429 就让本 isolate 余生所有 fetchByContract 直接失败,而且是静默的
  // (上层 SWR 把抛错当「上游没有」吞掉)。
  it("平台表拉失败 → 不记住,下一次重新拉并成功", async () => {
    // 两处跟 client 的重试/限速有关的细节:
    //   · 前**两**次失败,不是一次 —— client 会对可重试错误重试一次,一次失败会被它吸收掉
    //   · 用 **503** 而不是 429 —— 429 连着两发会让 client 进冷却(5s 内不再出网),那会盖住
    //     这条用例真正要钉的东西(失败的 promise 不进记忆槽)。冷却本身另有用例覆盖
    let attempt = 0;
    stubFetch({
      "/asset_platforms": () => (++attempt <= 2 ? new Error("503") : PLATFORMS),
      "/contract/": { id: "usd-coin", symbol: "usdc", name: "USD Coin" },
    });
    const upstream = createCoinGeckoUpstream(NO_WAIT);

    await expect(upstream.fetchByContract("1", "0xa0b8")).rejects.toThrow();
    const got = await upstream.fetchByContract("1", "0xa0b8");

    expect(got?.symbol).toBe("usdc");
    expect(attempt).toBe(3); // 第一轮 2 发(重试用尽)+ 第二轮 1 发
  });
});

describe("不是本源命名的 ref → 不发请求", () => {
  it("取价:一个都翻不出 coin id 就不问", async () => {
    const calls = stubFetch({ "/simple/price": {} });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchPrices([
      "evm:1/contract:0xa0b8",
      "binance/issued:USDC",
    ]);
    expect(got.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("取价:混着本源命名的 → 只把翻得出的那些送上去", async () => {
    const calls = stubFetch({ "/simple/price": { "usd-coin": { usd: 1, last_updated_at: 1700 } } });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchPrices([
      "evm:1/contract:0xa0b8",
      "coingecko/issued:usd-coin",
    ]);

    expect(calls[0].query.get("ids")).toBe("usd-coin");
    expect(got.get("coingecko/issued:usd-coin")?.unitPrice).toBe(1);
  });

  it("历史价:链上寻址的 ref 本源给不出 → 空,不发请求", async () => {
    const calls = stubFetch({ "/market_chart/range": { prices: [] } });
    expect(
      await createCoinGeckoUpstream(NO_WAIT).fetchPriceSeries("evm:1/contract:0xa0b8", 0, 1),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("历史价:本源命名的 → 区间按秒送,毫秒向外取整", async () => {
    const calls = stubFetch({ "/market_chart/range": { prices: [[1700000000000, 1]] } });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchPriceSeries(
      "coingecko/issued:usd-coin",
      1500,
      2500,
    );

    expect(calls[0].path).toContain("/coins/usd-coin/market_chart/range");
    expect(calls[0].query.get("from")).toBe("1"); // floor(1500/1000)
    expect(calls[0].query.get("to")).toBe("3"); // ceil(2500/1000)
    expect(got).toHaveLength(1);
  });
});

// 点查一批整行。**必须走 `/coins/markets?ids=`,不能走 `/simple/price`** —— 后者只回价,
// 不回 name/symbol/image,而这个方法存在的全部理由就是要那三个字段(上游是它们的权威 home)。
describe("fetchTokens 按 id 点查整行", () => {
  it("打 /coins/markets 并把 ids 指名送上去,不翻页", async () => {
    const calls = stubFetch({
      "/coins/markets": [marketRow("usd-coin", 6), marketRow("ethereum", 2)],
    });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchTokens([
      "coingecko/issued:usd-coin",
      "coingecko/issued:ethereum",
    ]);

    expect(calls).toHaveLength(1); // 一次,没有 page=2
    expect(calls[0].path).toContain("/coins/markets");
    expect(calls[0].query.get("ids")).toBe("usd-coin,ethereum");
    expect(calls[0].query.get("price_change_percentage")).toBe("24h");
    expect(got.map((t) => t.ref)).toEqual([
      "coingecko/issued:usd-coin",
      "coingecko/issued:ethereum",
    ]);
    expect(got[0].name).toBe("usd-coin"); // 名与图确实回来了(这才是它与 fetchPrices 的差别)
  });

  it("一个都翻不出 coin id → 不发请求", async () => {
    const calls = stubFetch({ "/coins/markets": [] });
    expect(
      await createCoinGeckoUpstream(NO_WAIT).fetchTokens([
        "evm:1/contract:0xa0b8",
        "binance/issued:USDC",
      ]),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("上游没收录的 id 不出现在结果里(不是报错)", async () => {
    stubFetch({ "/coins/markets": [marketRow("usd-coin", 6)] });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchTokens([
      "coingecko/issued:usd-coin",
      "coingecko/issued:never-listed",
    ]);
    expect(got.map((t) => t.ref)).toEqual(["coingecko/issued:usd-coin"]);
  });
});

describe("搜索与全局映射", () => {
  it("搜索透传查询词", async () => {
    const calls = stubFetch({ "/search": { coins: [{ id: "usd-coin", symbol: "usdc" }] } });
    const got = await createCoinGeckoUpstream(NO_WAIT).searchTokens("usdc");

    expect(calls[0].query.get("query")).toBe("usdc");
    expect(got[0]?.ref).toBe(`${UPSTREAM_ID}/issued:usd-coin`);
  });

  it("全局映射一次并发拉两个端点(币目录 + 平台表)", async () => {
    const calls = stubFetch({
      "/coins/list": [{ id: "usd-coin", symbol: "usdc", platforms: { ethereum: "0xA0B8" } }],
      "/asset_platforms": PLATFORMS,
    });
    const got = await createCoinGeckoUpstream(NO_WAIT).fetchRefIndex();

    expect(calls.map((c) => c.path.split("/api/v3")[1]).sort()).toEqual([
      "/asset_platforms",
      "/coins/list",
    ]);
    expect(calls.find((c) => c.path.includes("/coins/list"))?.query.get("include_platform")).toBe(
      "true",
    );
    expect(got.rows).toEqual([
      { ref: "evm:1/contract:0xa0b8", namer: UPSTREAM_ID, localName: "usd-coin" },
    ]);
  });
});
