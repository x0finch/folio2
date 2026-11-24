import { useLocale } from "use-intl";
import { formatMoney } from "@/lib/core/format-number";
import { usePreferCurrency } from "./use-prefer-currency";

// Money only: currency conversion must not apply to token amounts (use formatNumber for those).
export function useDisplayValue(): (value: number, opts?: { compact?: boolean }) => string {
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  return (value: number, opts?: { compact?: boolean }) =>
    formatMoney(value, { rate, locale, currency, compact: opts?.compact });
}
