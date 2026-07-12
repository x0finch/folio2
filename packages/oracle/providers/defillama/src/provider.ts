import type { TokenInfo, TokenPrice, TokenProvider } from "@folio/oracle-basic";
import { CHAIN_ALIASES, PRICE_PATH } from "./constants";
import { createRequester, type DefiLlamaConfig } from "./http";
import { parseCoin, parseCurrentPrices } from "./parse";

export type { DefiLlamaConfig };

// 我们的链标识 → DefiLlama slug(别名表命中优先,否则小写兜底)。
function toChainSlug(chain: string): string {
  const c = chain.toLowerCase();
  return CHAIN_ALIASES[chain] ?? CHAIN_ALIASES[c] ?? c;
}

// DefiLlama 的 `TokenProvider` **取价面**实现(#80):按 coin key(`{chain}:{address}` / `coingecko:{id}`)取价。
// vendor 仅声明 prices —— 故 markets/search 恒空(它非 tokenMeta/搜索源,身份/元信息权威留 baseline CoinGecko)。
// fetchByContract 亦走同一 /prices/current 端点(链:合约地址 → 价),info 只带 symbol。尚未 user-facing:
// 路由/设置接入见 P3-6。
export function createDefiLlamaProvider(config: DefiLlamaConfig = {}): TokenProvider {
  const request = createRequester(config);

  const provider: TokenProvider = {
    source: "defillama",

    // 非价面:DefiLlama 无 top-N markets / 搜索 → 恒空(能力仅 prices)。
    async fetchMarkets(): Promise<{ info: TokenInfo; price: TokenPrice }[]> {
      return [];
    },
    async searchTokens(): Promise<TokenInfo[]> {
      return [];
    },

    // 链:合约地址 → 价。chain 翻成 DefiLlama slug,拼 key 单查;无价 → null。
    async fetchByContract(chain, contract) {
      const key = `${toChainSlug(chain)}:${contract.toLowerCase()}`;
      const json = await request(`${PRICE_PATH}/${key}`);
      return parseCoin(json, key);
    },

    // 长尾/刷价:只认 source==="defillama" 的 ref,其 identifier 即 coin key。逗号拼一次批量取。
    async fetchPrices(refs) {
      const keys = refs.filter((r) => r.source === "defillama").map((r) => r.identifier);
      if (keys.length === 0) return new Map<string, TokenPrice>();
      const json = await request(`${PRICE_PATH}/${keys.join(",")}`);
      return parseCurrentPrices(json);
    },
  };
  return provider;
}
