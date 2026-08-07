import { runClient } from "@folio/client-core/testing";
import type { AssetPlatform, MarketCoin } from "@folio/coingecko-client";
import { TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
// 单页上限不进导出面(调用方不需要知道分页存在),测分页边界要从常量模块直接取。
import { IDS_PER_REQUEST, MARKETS_PER_PAGE, UPSTREAM_ID } from "../src/constants";
import { coinGeckoTokenUpstreamLayer, makeUpstreamEffects } from "../src/upstream";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };
import { type Call, routed, run, type Stub, stubbing } from "./harness";

// 把 `parse.ts` / `ref-index.ts` 的纯转换串成真上游的那一层:分页、链标识翻译、平台表记忆。
// 打的桩是 **`HttpClient` 服务**,所以顺带钉住 adapter 究竟问了哪个端点、带了什么参数 ——
// 换成注入假 client 就看不见这一截了。

const PLATFORMS = assetPlatforms as AssetPlatform[];

// 每个用例一份新的实现 —— 平台表记忆是实例级的,共用会串味。
const impl = () => makeUpstreamEffects();

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

describe("端口 layer", () => {
  // 装配点只 import 这个 layer,所以它至少要被走一次:`R = never`(client 与 HttpClient 在
  // 包内被关掉了)、`id` 是本 adapter 的常量(服务层拿它当 ref 的命名者)。
  it("layer 给出的端口自报 id,且不再要求调用方 provide 传输层", async () => {
    const stub = routed({ "/coins/markets": [] });
    const id = await runClient(
      stub.http,
      Effect.map(TokenUpstream, (u) => u.id).pipe(Effect.provide(coinGeckoTokenUpstreamLayer())),
      "none",
    );
    expect(id).toBe(UPSTREAM_ID);
  });

  it("经 layer 拿到的方法照样能出网(接线没断)", async () => {
    const stub = routed({ "/coins/markets": [marketRow("bitcoin", 1)] });
    const rows = await runClient(
      stub.http,
      Effect.flatMap(TokenUpstream, (u) => u.fetchMarkets({ topN: 1 })).pipe(
        Effect.provide(coinGeckoTokenUpstreamLayer()),
      ),
      "none",
    );
    expect(rows.map((r) => r.ref)).toEqual(["coingecko/issued:bitcoin"]);
  });
});

describe("fetchMarkets 分页", () => {
  it("topN 跨页 → 逐页取,页码递增,末尾裁到 topN", async () => {
    let n = 0;
    const stub = routed({ "/coins/markets": () => page(MARKETS_PER_PAGE, ++n) });
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE + 10 }));

    expect(stub.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
    expect(stub.calls[0].query.get("per_page")).toBe(String(MARKETS_PER_PAGE));
    // 两页各 250 行,但只要 260 → 裁掉多的。
    expect(rows).toHaveLength(MARKETS_PER_PAGE + 10);
  });

  it("单页装得下 → 只请求一次", async () => {
    const stub = routed({ "/coins/markets": () => page(10) });
    expect(await run(stub, impl().fetchMarkets({ topN: 10 }))).toHaveLength(10);
    expect(stub.calls).toHaveLength(1);
  });

  // 上游币数少于要的:不足一页就说明没有下一页了,继续问只是白白多一次 429 的机会。
  it("上游给不满一页 → 提前收手,不问下一页", async () => {
    const stub = routed({ "/coins/markets": () => page(3) });
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 3 }));

    expect(stub.calls).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it("topN 小于一页也至少问一次(不产出 0 页)", async () => {
    const stub = routed({ "/coins/markets": () => page(1) });
    await run(stub, impl().fetchMarkets({ topN: 0 }));
    expect(stub.calls).toHaveLength(1);
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

  const twoPages = () => {
    let n = 0;
    return routed({ "/coins/markets": () => overlapping(++n) });
  };

  it("同一个币出现在两页 → 只留一条", async () => {
    const rows = await run(twoPages(), impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    const refs = rows.map((r) => r.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("留下的是**先出现**的那条 —— 它排得更靠前", async () => {
    const rows = await run(twoPages(), impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    const dup = rows.filter((r) => r.ref === `${UPSTREAM_ID}/issued:coin-249`);
    expect(dup).toHaveLength(1);
    // 第 1 页给的排名是 250;第 2 页那条也是 250,但位置在第 1 页 —— 取的是先来的。
    expect(rows.indexOf(dup[0])).toBe(MARKETS_PER_PAGE - 1);
  });

  // 去重之后就是会少于 topN。补齐要多翻页,而多翻的那页照样会撞重复 —— 补不出保证,
  // 少的又都在榜尾最不稳的一段。所以 topN 的意思是「往下抓多深」,不是「保证这么多个币」。
  it("去重后不足 topN → 就是不足,不再多翻页去补", async () => {
    const stub = twoPages();
    const rows = await run(stub, impl().fetchMarkets({ topN: MARKETS_PER_PAGE * 2 }));

    expect(rows).toHaveLength(MARKETS_PER_PAGE * 2 - 1);
    expect(stub.calls).toHaveLength(2); // 没有第 3 页
  });
});

describe("不是本源命名的 ref → 不发请求", () => {
  it("取价:一个都翻不出 coin id 就不问", async () => {
    const stub = routed({ "/simple/price": {} });
    const got = await run(
      stub,
      impl().fetchPrices(["evm:1/contract:0xa0b8", "binance/issued:USDC"]),
    );
    expect(got.size).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("取价:混着本源命名的 → 只把翻得出的那些送上去", async () => {
    const stub = routed({ "/simple/price": { "usd-coin": { usd: 1, last_updated_at: 1700 } } });
    const got = await run(
      stub,
      impl().fetchPrices(["evm:1/contract:0xa0b8", "coingecko/issued:usd-coin"]),
    );

    expect(stub.calls[0].query.get("ids")).toBe("usd-coin");
    expect(got.get("coingecko/issued:usd-coin")?.unitPrice).toBe(1);
  });

  it("历史价:链上寻址的 ref 本源给不出 → 空,不发请求", async () => {
    const stub = routed({ "/market_chart/range": { prices: [] } });
    expect(await run(stub, impl().fetchPriceSeries("evm:1/contract:0xa0b8", 0, 1))).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it("历史价:本源命名的 → 区间按秒送,毫秒向外取整", async () => {
    const stub = routed({ "/market_chart/range": { prices: [[1700000000000, 1]] } });
    const got = await run(stub, impl().fetchPriceSeries("coingecko/issued:usd-coin", 1500, 2500));

    expect(stub.calls[0].path).toContain("/coins/usd-coin/market_chart/range");
    expect(stub.calls[0].query.get("from")).toBe("1"); // floor(1500/1000)
    expect(stub.calls[0].query.get("to")).toBe("3"); // ceil(2500/1000)
    expect(stub.calls[0].query.get("vs_currency")).toBe("usd"); // 缺省 USD
    expect(got).toHaveLength(1);
  });

  // 法币历史汇率反算(ADR 0026)用它取「BTC 在某法币下的价」那条腿 —— 同一个取数口,只换 vs_currency。
  it("历史价:vsCurrency 可换 —— 传 EUR 归一成小写 eur 送上游", async () => {
    const stub = routed({ "/market_chart/range": { prices: [[1700000000000, 92000]] } });
    await run(stub, impl().fetchPriceSeries("coingecko/issued:bitcoin", 1500, 2500, "EUR"));

    expect(stub.calls[0].path).toContain("/coins/bitcoin/market_chart/range");
    expect(stub.calls[0].query.get("vs_currency")).toBe("eur");
  });
});

// 点查一批整行。**必须走 `/coins/markets?ids=`,不能走 `/simple/price`** —— 后者只回价,
// 不回 name/symbol/image,而这个方法存在的全部理由就是要那三个字段(上游是它们的权威 home)。
describe("fetchTokens 按 id 点查整行", () => {
  it("打 /coins/markets 并把 ids 指名送上去,不翻页", async () => {
    const stub = routed({
      "/coins/markets": [marketRow("usd-coin", 6), marketRow("ethereum", 2)],
    });
    const got = await run(
      stub,
      impl().fetchTokens(["coingecko/issued:usd-coin", "coingecko/issued:ethereum"]),
    );

    expect(stub.calls).toHaveLength(1); // 一次,没有 page=2
    expect(stub.calls[0].path).toContain("/coins/markets");
    expect(stub.calls[0].query.get("ids")).toBe("usd-coin,ethereum");
    expect(stub.calls[0].query.get("price_change_percentage")).toBe("24h");
    expect(got.map((t) => t.ref)).toEqual([
      "coingecko/issued:usd-coin",
      "coingecko/issued:ethereum",
    ]);
    expect(got[0].name).toBe("usd-coin"); // 名与图确实回来了(这才是它与 fetchPrices 的差别)
  });

  it("一个都翻不出 coin id → 不发请求", async () => {
    const stub = routed({ "/coins/markets": [] });
    expect(
      await run(stub, impl().fetchTokens(["evm:1/contract:0xa0b8", "binance/issued:USDC"])),
    ).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it("上游没收录的 id 不出现在结果里(不是报错)", async () => {
    const stub = routed({ "/coins/markets": [marketRow("usd-coin", 6)] });
    const got = await run(
      stub,
      impl().fetchTokens(["coingecko/issued:usd-coin", "coingecko/issued:never-listed"]),
    );
    expect(got.map((t) => t.ref)).toEqual(["coingecko/issued:usd-coin"]);
  });
});

// 数百币的钱包:id 全塞进一条 GET 的 `ids=` → URL 超 URI 上限 → CoinGecko 414,整批挂
// (#245)。这几条钉的是「id 必须分块、逐批取、结果合并」—— 单批测试(上面)只覆盖不分块的路径。
describe("大批 id 分块(#245:避免 414)", () => {
  const refsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `${UPSTREAM_ID}/issued:coin-${i}`);

  // 按 query 里的 ids 动态回响应(routed 的路由值看不到 query,分块测试要的正是这个)。
  // 每批把它收到的 id 各回一条 —— 于是「合并了所有批」才拿得到全部 n 条。
  const echoingIds = (build: (ids: string[]) => unknown): Stub =>
    stubbing((call) => build((call.query.get("ids") ?? "").split(",").filter(Boolean)));

  const eachBatchWithinLimit = (calls: readonly Call[]) => {
    for (const c of calls) {
      expect((c.query.get("ids") ?? "").split(",").length).toBeLessThanOrEqual(IDS_PER_REQUEST);
    }
  };

  it("取价:id 数 > 单批上限 → 切成多批,每批 ids ≤ 上限,结果合并", async () => {
    const n = IDS_PER_REQUEST * 2 + 5; // 3 批:满、满、余 5
    const stub = echoingIds((ids) =>
      Object.fromEntries(ids.map((id) => [id, { usd: 1, last_updated_at: 1700 }])),
    );

    const got = await run(stub, impl().fetchPrices(refsOf(n)));

    expect(stub.calls).toHaveLength(3);
    eachBatchWithinLimit(stub.calls);
    expect(got.size).toBe(n); // 每一批的价都进了合并后的 Map
  });

  it("取整行:同样分块,每批 ≤ 上限,行数是各批之和", async () => {
    const n = IDS_PER_REQUEST + 1; // 2 批
    const stub = echoingIds((ids) => ids.map((id, i) => marketRow(id, i + 1)));

    const got = await run(stub, impl().fetchTokens(refsOf(n)));

    expect(stub.calls).toHaveLength(2);
    eachBatchWithinLimit(stub.calls);
    expect(got).toHaveLength(n);
  });

  it("恰好一批(= 上限)→ 只发一次,不多切", async () => {
    const stub = routed({ "/simple/price": { "coin-0": { usd: 1, last_updated_at: 1700 } } });
    await run(stub, impl().fetchPrices(refsOf(IDS_PER_REQUEST)));
    expect(stub.calls).toHaveLength(1);
  });
});

describe("搜索与全局映射", () => {
  it("搜索透传查询词", async () => {
    const stub = routed({ "/search": { coins: [{ id: "usd-coin", symbol: "usdc" }] } });
    const got = await run(stub, impl().searchTokens("usdc"));

    expect(stub.calls[0].query.get("query")).toBe("usdc");
    expect(got[0]?.ref).toBe(`${UPSTREAM_ID}/issued:usd-coin`);
  });

  it("全局映射一次并发拉两个端点(币目录 + 平台表)", async () => {
    const stub = routed({
      "/coins/list": [{ id: "usd-coin", symbol: "usdc", platforms: { ethereum: "0xA0B8" } }],
      "/asset_platforms": PLATFORMS,
    });
    const got = await run(stub, impl().fetchRefIndex());

    expect(stub.calls.map((c) => c.path.split("/api/v3")[1]).sort()).toEqual([
      "/asset_platforms",
      "/coins/list",
    ]);
    expect(
      stub.calls.find((c) => c.path.includes("/coins/list"))?.query.get("include_platform"),
    ).toBe("true");
    expect(got.rows).toEqual([
      { chainRef: "evm:1/contract:0xa0b8", upstreamRef: `${UPSTREAM_ID}/issued:usd-coin` },
    ]);
  });
});
