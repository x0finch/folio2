// DefiLlama coins API 接入常量。keyless 公共端点(coins.llama.fi),无鉴权头。

// coins API 基址(价格 / 合约寻址均在此)。
export const DL_BASE = "https://coins.llama.fi";
// 当前价路径前缀:`/prices/current/{coins}`,coins = 逗号分隔的 coin key。
export const PRICE_PATH = "/prices/current";

// CF Workers fetch 默认不带 UA,某些边缘 WAF 会 403 → 恒注入(与 coingecko-client 同策)。
export const USER_AGENT = "folio-portfolio-tracker/1.0 (+https://github.com/x0finch/folio)";

// 我们的链标识 → DefiLlama 链 slug。EVM chainId(数字)与常见 CGK slug 双键,
// 覆盖不到则 lowercased 兜底(DefiLlama 多数链 slug 即小写名)。fetchByContract 用。
export const CHAIN_ALIASES: Record<string, string> = {
  "1": "ethereum",
  ethereum: "ethereum",
  "137": "polygon",
  "polygon-pos": "polygon",
  polygon: "polygon",
  "56": "bsc",
  "binance-smart-chain": "bsc",
  bsc: "bsc",
  "42161": "arbitrum",
  "arbitrum-one": "arbitrum",
  arbitrum: "arbitrum",
  "10": "optimism",
  "optimistic-ethereum": "optimism",
  optimism: "optimism",
  "8453": "base",
  base: "base",
  "43114": "avax",
  avalanche: "avax",
  avax: "avax",
};
