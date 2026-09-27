import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { createContext, useContext } from "react";
import { storedPreference } from "./stored-preference";

// 偏好币种 + 汇率,由 _authed loader 解析(localStorage 里的币种码 + 服务端取汇率)经 context 下发。
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

// 选中的**币种码**(每浏览器,localStorage)。汇率仍要 per-user 的服务端缓存,所以码作为参数交给
// `getCurrencyPreference`,服务端再校验一遍 —— 这里的 SUPPORTED 校验只为别把垃圾放进查询键。
const SUPPORTED_CODES = new Set(SUPPORTED_CURRENCIES.map((c) => c.code));

// 与 `lib/i18n/locale-preference.ts` 的 `KEY` 同形:localStorage 键具名,不散在调用里。
const KEY = "folio_currency";

export const {
  read: readStoredCurrency,
  write: storeCurrency,
  useValue: useStoredCurrency,
} = storedPreference(
  KEY,
  (raw) => (raw !== null && SUPPORTED_CODES.has(raw) ? raw : DEFAULT_CURRENCY),
  DEFAULT_CURRENCY,
);
