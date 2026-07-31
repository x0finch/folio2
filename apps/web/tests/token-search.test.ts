import { describe, expect, it } from "vitest";
import type { TokenOption } from "../src/lib/token-option";
import {
  buildTokenSections,
  type LivePrice,
  LOCAL_SEARCH_ENOUGH,
  mergeSearchResults,
  needsRemoteSearch,
  PRICE_STALE_MS,
  searchCatalogue,
  staleTickets,
} from "../src/lib/token-search";

// 选币搜索的本地那一档:在整份下发的目录里就地筛,只有凑不够才轮到上游。
// 这些用例钉的是**排序意图**和**什么时候才出网** —— 前者决定用户敲 BTC 第一行是不是比特币,
// 后者决定这次改动到底省没省掉那趟 CGK。

const opt = (symbol: string, name: string): TokenOption => ({
  ticket: `t-${symbol}-${name}`.toLowerCase().replace(/\s+/g, "-"),
  symbol,
  name,
});

// 入参顺序 = 市值排名(服务端排好序发过来的)。
//
// **这份 fixture 是照着「能不能把分档和纯按市值区分开」挑的**:`eth` 这个词上,市值最高的
// 两条(Tether / Wrapped Ether)都只是子串命中,而全等的 ETH 与前缀的 ETHW 市值都更低 ——
// 所以只要有一档搞错,顺序立刻不一样。第一版 fixture 没有这个性质,把分档整个删掉测试照样全绿。
const CATALOGUE: TokenOption[] = [
  opt("BTC", "Bitcoin"), // 1
  opt("USDT", "Tether"), // 2  名字里含 eth,但不是前缀
  opt("WETH", "Wrapped Ether"), // 3  symbol 与名字都含 eth,都不是前缀
  opt("BITCI", "Bitcicoin"), // 4  symbol 以 bitc 开头
  opt("ETHW", "EthereumPoW"), // 5  symbol 以 eth 开头
  opt("ETH", "Ethereum"), // 6  全等
  opt("SOL", "Solana"), // 7
  opt("WBTC", "Wrapped Bitcoin"), // 8
  opt("TBTC", "tBTC"), // 9
  opt("SOLV", "Solv Protocol"), // 10
];

describe("本地筛:分档 + 同档按市值", () => {
  it("全等 → 前缀 → 子串,同档才按市值", () => {
    // 纯按市值的话会排成 USDT / WETH / ETHW / ETH —— 正好整个反过来。
    expect(searchCatalogue(CATALOGUE, "eth").map((t) => t.symbol)).toEqual([
      "ETH",
      "ETHW",
      "USDT",
      "WETH",
    ]);
  });

  it("全等压得过市值 —— 敲 ETH 第一行必须是以太坊,不是排名更高的 Tether", () => {
    expect(searchCatalogue(CATALOGUE, "eth")[0]?.symbol).toBe("ETH");
  });

  it("命中在 symbol 还是名字上不分高下 —— 敲 bitc 第一行是 Bitcoin,不是 Bitcicoin", () => {
    // 两条都是前缀命中(BITCI 命在 symbol、Bitcoin 命在名字),于是市值说了算。
    // 曾经把这两种拆成两档,结果市值第 4 的 BITCI 压过了第 1 的 Bitcoin。
    const got = searchCatalogue(CATALOGUE, "bitc").map((t) => t.symbol);
    expect(got).toEqual(["BTC", "BITCI", "WBTC"]); // 末位是子串命中(Wrapped Bitcoin)
  });

  it("名字里的子串也搜得到 —— 用户常按全名找", () => {
    expect(searchCatalogue(CATALOGUE, "wrapped").map((t) => t.symbol)).toEqual(["WETH", "WBTC"]);
  });

  it("大小写与前后空白不敏感", () => {
    expect(searchCatalogue(CATALOGUE, "  EtH  ")[0]?.symbol).toBe("ETH");
  });

  it("空 query → 空(默认列是另一条路:目录前 N 条,不走筛)", () => {
    expect(searchCatalogue(CATALOGUE, "")).toEqual([]);
    expect(searchCatalogue(CATALOGUE, "   ")).toEqual([]);
  });

  it("一条都不沾的词 → 空,不是「全给」", () => {
    expect(searchCatalogue(CATALOGUE, "zzzzz")).toEqual([]);
  });

  it("截到上限,截掉的是排在后面那些", () => {
    expect(searchCatalogue(CATALOGUE, "eth", 2).map((t) => t.symbol)).toEqual(["ETH", "ETHW"]);
  });

  it("目录还没到(预取未完成)→ 空,不炸", () => {
    expect(searchCatalogue([], "btc")).toEqual([]);
  });
});

describe("什么时候才轮到上游", () => {
  it("本地凑够了就不出网 —— 这是整个改动省下的那趟请求", () => {
    const enough = Array.from({ length: LOCAL_SEARCH_ENOUGH }, (_, i) => opt(`X${i}`, `Coin ${i}`));
    expect(needsRemoteSearch(enough)).toBe(false);
  });

  it("本地凑不够 → 用户多半在找长尾币,这时一次 /search 花得值", () => {
    expect(needsRemoteSearch([])).toBe(true);
    expect(needsRemoteSearch([opt("BTC", "Bitcoin")])).toBe(true);
  });
});

describe("合并上游补的那几条", () => {
  const local = [opt("BTC", "Bitcoin"), opt("WBTC", "Wrapped Bitcoin")];

  it("本地在前(它按市值排过档),上游的接在后面", () => {
    const remote = [opt("BTCX", "Bitcoin X")];
    expect(mergeSearchResults(local, remote).map((t) => t.symbol)).toEqual(["BTC", "WBTC", "BTCX"]);
  });

  it("按票去重 —— 上游回的同一个币不重复出现", () => {
    const dup = opt("BTC", "Bitcoin"); // 同 symbol+名 → 同票
    expect(mergeSearchResults(local, [dup, opt("BTCX", "Bitcoin X")])).toHaveLength(3);
  });

  it("截到上限,截的是上游那侧(本地已经排好)", () => {
    const remote = Array.from({ length: 30 }, (_, i) => opt(`R${i}`, `Remote ${i}`));
    const got = mergeSearchResults(local, remote, 5);
    expect(got).toHaveLength(5);
    expect(got.slice(0, 2)).toEqual(local);
  });

  it("上游没回 / 挂了 → 就给本地那几条", () => {
    expect(mergeSearchResults(local, [])).toEqual(local);
  });
});

// 选币下拉的分组(#269):未搜索时不再是「目录前 N 条」一根扁平列表,而是有序的 section ——
// **已有代币 → 法币 → Tokens(目录)**。这些用例钉的是外部行为:组的顺序、空组不占位、两组
// **刻意不去重**(同一个币在「已有代币」和「Tokens」各出现一次,有组标题不误导),以及搜索时
// 各组内部各自过滤(复用 searchCatalogue 那套分档)。法币组本票不填(空数组),只验它占的那个位。
describe("选币分组:已有代币 → 法币 → Tokens", () => {
  const OWNED: TokenOption[] = [
    opt("ETH", "Ethereum"), // 也在目录里 —— 用来验两组不去重
    opt("MYC", "My Custom Coin"), // 自定义 symbol 币,目录里没有
  ];
  const keys = (secs: ReturnType<typeof buildTokenSections>) => secs.map((s) => s.key);
  const items = (secs: ReturnType<typeof buildTokenSections>, key: string) =>
    secs.find((s) => s.key === key)?.items.map((t) => t.symbol) ?? [];

  it("未搜索:已有代币在上、Tokens 在下;已有代币全给,目录截到 topN", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(secs)).toEqual(["owned", "catalogue"]); // 顺序:已有代币在上
    expect(items(secs, "owned")).toEqual(["ETH", "MYC"]); // 已有代币全给
    expect(items(secs, "catalogue")).toEqual(["BTC", "USDT", "WETH"]); // 目录前 topN 条
  });

  it("法币组占中间那个位(非空时顺序 已有代币 → 法币 → Tokens)", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [opt("USD", "US Dollar")],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 2,
    });
    expect(keys(secs)).toEqual(["owned", "fiat", "catalogue"]);
  });

  it("空组不出现:法币空 → 没有法币组;已有代币空 → 以 Tokens 起头", () => {
    const withOwned = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(withOwned)).not.toContain("fiat");

    const noOwned = buildTokenSections({
      owned: [],
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(noOwned)).toEqual(["catalogue"]);
  });

  it("两组不去重:同一个币在「已有代币」和「Tokens」各出现一次", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "eth",
      catalogueTopN: 3,
    });
    // ETH 既是已添加的、又在目录里 —— 两组各出现一次,不合并。
    expect(items(secs, "owned")).toContain("ETH");
    expect(items(secs, "catalogue")).toContain("ETH");
  });

  it("搜索:各组内部各自过滤(复用 searchCatalogue 的分档)", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "myc",
      catalogueTopN: 3,
    });
    // 「myc」只命中已有代币里的自定义币,目录里一条都不沾 → 只剩已有代币组。
    expect(keys(secs)).toEqual(["owned"]);
    expect(items(secs, "owned")).toEqual(["MYC"]);
  });

  it("搜索时上游补的那几条并进 Tokens 组(本地在前)", () => {
    const secs = buildTokenSections({
      owned: [],
      fiat: [],
      catalogue: [opt("BTC", "Bitcoin")],
      query: "btc",
      catalogueTopN: 3,
      remote: [opt("BTCX", "Bitcoin X")],
    });
    expect(items(secs, "catalogue")).toEqual(["BTC", "BTCX"]);
  });
});

describe("展示时挑该刷价的票", () => {
  const NOW = 1_700_000_000_000;
  const withPrice = (symbol: string, over: Partial<TokenOption> = {}): TokenOption => ({
    ...opt(symbol, symbol),
    ...over,
  });
  const noLive = new Map<string, LivePrice>();
  const noReq = new Set<string>();

  it("新鲜的不刷,过期的刷,缺价的刷", () => {
    const tokens = [
      withPrice("FRESH", { asOf: NOW - 1000 }), // 1s 前 → 新鲜
      withPrice("OLD", { asOf: NOW - PRICE_STALE_MS - 1000 }), // 超过阈值 → 刷
      withPrice("NONE"), // 无 asOf(搜索来的无价行)→ 刷
    ];
    expect(staleTickets(tokens, noLive, noReq, NOW)).toEqual([
      tokens[1]?.ticket,
      tokens[2]?.ticket,
    ]);
  });

  it("刷来的价(live)盖过票自带的旧价 —— 补过就不再算过期", () => {
    const tk = withPrice("OLD", { asOf: NOW - PRICE_STALE_MS - 1000 });
    const live = new Map<string, LivePrice>([[tk.ticket, { price: 1, asOf: NOW }]]);
    expect(staleTickets([tk], live, noReq, NOW)).toEqual([]);
  });

  it("已请求过的票不再挑 —— 每次打开只补一次,防刷价打成环", () => {
    // 上游没回价的票不会进 live、永远算缺价;requested 才是那道闸。
    const tk = withPrice("NORESP"); // 无价、也不在 live 里
    expect(staleTickets([tk], noLive, new Set([tk.ticket]), NOW)).toEqual([]);
  });
});
