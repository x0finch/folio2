import type { PriceSource, TokenPrice } from "@folio/oracle-basic";
import { CHAIN_ALIASES, PRICE_PATH } from "./constants";
import { createRequester, type DefiLlamaConfig } from "./http";
import { parseCoin, parseCurrentPrices } from "./parse";

export type { DefiLlamaConfig };

// 我们的链标识 → DefiLlama slug(别名表命中优先,否则小写兜底)。
function toChainSlug(chain: string): string {
  const c = chain.toLowerCase();
  return CHAIN_ALIASES[chain] ?? CHAIN_ALIASES[c] ?? c;
}

// DefiLlama 的 `PriceSource` 实现(#80):按 coin key(`{chain}:{address}` / `coingecko:{id}`)取价。
// 只实现点查面(fetchByContract / fetchPrices)—— DefiLlama 无币目录/搜索(那是 TokenMetaSource,身份/
// 元信息权威留 baseline CoinGecko),故不实现 markets/search。fetchByContract 亦走 /prices/current 端点
// (链:合约地址 → 价),info 只带 symbol。运行时价格路由接入见 #83。
export function createDefiLlamaSource(config: DefiLlamaConfig = {}): PriceSource {
  const request = createRequester(config);

  const source: PriceSource = {
    source: "defillama",

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
  return source;
}
