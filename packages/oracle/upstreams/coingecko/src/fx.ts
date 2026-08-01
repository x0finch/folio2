import { type CoinGeckoConfig, createCoinGeckoClient } from "@folio/coingecko-client";
import type { FxUpstream } from "@folio/oracle-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { BTC_COIN_ID, UPSTREAM_ID } from "./constants";

// `FxUpstream` 的 CoinGecko 实现。上游那个端点(`/exchange_rates`)**以 BTC 为基准**报价:
// 每一项的 value = 1 BTC 值多少该币种。我们要的是「1 单位该币种值多少美元」,于是
//   usdPerUnit(X) = rates.usd.value / rates.X.value       (BTC 约掉)
//
// 只反算白名单里那十来个币种:上游给几百种,多出来的没有格式化规则也没人选得到。
export function createCoinGeckoFxUpstream(config: CoinGeckoConfig = {}): FxUpstream {
  const client = createCoinGeckoClient(config);
  return {
    id: UPSTREAM_ID,

    // 汇率的 BTC 反算基,也是 BTC 美元历史腿的缓存键 —— 与 token adapter 产 BTC ref 同一个串
    // (`coingecko/issued:bitcoin`),故与 `tokens.priceSeries` 落的 BTC 历史价共用全局行(ADR 0026)。
    // 两条历史腿都走 `PriceUpstream.fetchPriceSeries(btcRef, …, vsCurrency)`,本 adapter 不另立取数方法。
    btcRef: tokenRef.issued(UPSTREAM_ID, BTC_COIN_ID),

    async fetchRates() {
      const rates = (await client.exchangeRates()).rates ?? {};
      const usdPerBtc = rates.usd?.value;
      // 基准缺了就全盘算不出来 —— 这不是「某个币种没收录」,是响应坏了,得抛。
      if (typeof usdPerBtc !== "number" || usdPerBtc <= 0) {
        throw new Error("exchange_rates: missing/invalid usd rate");
      }
      const out = new Map<string, number>();
      for (const { code } of SUPPORTED_CURRENCIES) {
        if (code === "USD") {
          out.set("USD", 1);
          continue;
        }
        // 上游的键是小写。某个币种上游没有 → 不进结果(契约:不认识的不出现,不报错)。
        const perBtc = rates[code.toLowerCase()]?.value;
        if (typeof perBtc === "number" && perBtc > 0) out.set(code, usdPerBtc / perBtc);
      }
      return out;
    },
  };
}
