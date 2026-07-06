import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/fx";
import { createContext, useContext } from "react";

// 偏好币种 + 汇率,由 _authed loader 解析(cookie + FX cache-only)经 context 下发。
//   rate = 1 单位该币种的美元价(USD 恒 1);展示值 = usdValue / rate。
export interface PreferCurrency {
  currency: Currency;
  rate: number;
}

const USD = SUPPORTED_CURRENCIES.find((c) => c.code === DEFAULT_CURRENCY) as Currency;
const FALLBACK: PreferCurrency = { currency: USD, rate: 1 };

const CurrencyContext = createContext<PreferCurrency>(FALLBACK);
export const CurrencyProvider = CurrencyContext.Provider;

export function usePreferCurrency(): PreferCurrency {
  return useContext(CurrencyContext);
}
