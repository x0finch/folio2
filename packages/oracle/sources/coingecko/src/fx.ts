import {
  type CoinGeckoConfig,
  CoinGeckoError,
  createCoinGeckoClient,
} from "@folio/coingecko-client";
import { FxError, type FxSource, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";

// CoinGecko 的 FxSource:拉 /exchange_rates(以 BTC 为基准),对 SUPPORTED 各币种反算
// usdPerUnit = rates.usd.value / rates.<code>.value(BTC 约掉 → 1 单位该币种的美元价)。
export function createCoinGeckoFxSource(config: CoinGeckoConfig = {}): FxSource {
  const client = createCoinGeckoClient(config);
  return {
    async fetchRates() {
      let data: Awaited<ReturnType<typeof client.exchangeRates>>;
      try {
        data = await client.exchangeRates();
      } catch (e) {
        if (e instanceof CoinGeckoError) throw new FxError(e.code, e.message, { cause: e });
        throw e;
      }
      const rates = data.rates ?? {};
      const usdPerBtc = rates.usd?.value;
      if (typeof usdPerBtc !== "number" || usdPerBtc <= 0) {
        throw new FxError("PARSE_ERROR", "exchange_rates: missing/invalid usd rate");
      }
      const out = new Map<string, number>();
      for (const { code } of SUPPORTED_CURRENCIES) {
        if (code === "USD") {
          out.set("USD", 1);
          continue;
        }
        const perBtc = rates[code.toLowerCase()]?.value;
        if (typeof perBtc === "number" && perBtc > 0) out.set(code, usdPerBtc / perBtc);
      }
      return out;
    },
  };
}
