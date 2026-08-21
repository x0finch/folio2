import { useLocale } from "use-intl";
import { formatMoney } from "@/lib/core/format-number";
import { usePreferCurrency } from "./use-prefer-currency";

// 货币展示的单一入口。返回 (value: number) => string:按偏好币种换算 + fiat/crypto 格式化(见 formatMoney)。
// 换算不能作用于代币数量,故数量直接调 formatNumber;此 hook 只管货币。
export function useDisplayValue(): (value: number) => string {
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  return (value: number) => formatMoney(value, { rate, locale, currency });
}
