// CoinGecko adapter 的常量。**全仓只有本包认识这些东西**(ADR 0023)。

// 本 adapter 自报的标识 —— 它同时是产出 tokenRef 的 namer、以及全局映射表的 `namer` 列。
export const UPSTREAM_ID = "coingecko";

export const VS_USD = "usd";
export const SEARCH_LIMIT = 20;
export const MARKETS_PER_PAGE = 250; // CoinGecko 单页上限

// 按 id 批量取价 / 取整行时,每次 GET 送多少个 id。`/simple/price` 与 `/coins/markets?ids=`
// 都把 id 塞进 query 串,id 一多整条 URL 就超服务端 URI 长度上限 → CoinGecko 回 **HTTP 414
// URI Too Long**,整批失败(#245:数百币的钱包刷价/刷图恒挂)。故按此数分块请求再合并。
// 取值保守:coin id 是 slug,少数长达 ~40 字符,100 个即便全是长 slug(~4KB)也远在常见 8KB
// URI 上限内;且 100 ≤ MARKETS_PER_PAGE,故每批 `/coins/markets` 一页就装得下、无需翻页。
export const IDS_PER_REQUEST = 100;

// 非 EVM 链的显式 slug 对照:**我们的命名者 → CoinGecko 的 asset_platform id**。
//
// EVM 不需要这张表:两边都能归到 `evm:<chainId>` —— CoinGecko 的 `chain_identifier` 就是那个
// 数字,靠数字对齐不会歧义。非 EVM 没有这样的公共编号,是「连接器说 `solana`」对
// 「CoinGecko 说什么」,slug 对 slug。三条链恰好两边同名 **纯属运气**,不是规律 —— 所以写下来。
// 对不上的后果是这条链上的币从此没价没图、而且不报错;`toRefIndexRows` 会把对不上的链
// 单独喊出来(见 RefIndexFetch.unmatchedPlatforms)。
export const NON_EVM_PLATFORMS: Readonly<Record<string, string>> = {
  solana: "solana",
  sui: "sui",
  cosmos: "cosmos",
};

// symbol → CoinGecko coin id 的策展小表:majors + 已知撞名,优先于市值排名(防山寨撞名)。
// 键须为归一后的大写 symbol。**住在 adapter 里** —— 逐条写的都是 CoinGecko 的 id,
// 留在中立的契约层就是硬编码某一家(ADR 0023)。
export const OVERRIDES: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  TON: "the-open-network",
  DAI: "dai",
  AVAX: "avalanche-2",
  SUI: "sui",
  ATOM: "cosmos",
};

// EVM 命名者前缀:`evm:<chainId>` → CoinGecko 的合约端点要数字 chainId 翻出来的 slug。
export const EVM_NAMER_PREFIX = "evm:";
