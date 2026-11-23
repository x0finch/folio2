import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { createContext, useContext } from "react";
import { storedPreference } from "./stored-preference";

// rate = USD price of one unit of the currency (USD is 1); displayed value = usdValue / rate.
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

// The server validates the code again; this check only keeps garbage out of query keys.
const SUPPORTED_CODES = new Set(SUPPORTED_CURRENCIES.map((c) => c.code));

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
