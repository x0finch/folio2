import { useLocale } from "use-intl";
import { formatNumber } from "../format-number";
import { usePreferCurrency } from "./use-prefer-currency";

// 货币展示的单一入口(多币种接缝)。返回 (value: number) => string:
// 按偏好币种换算(value/rate)后走 formatNumber(unit 前缀 + locale)。
// 货币与数量共用同一个 formatNumber;此 hook 只多做「换算 + 货币符号」——换算不能作用于数量,故数量直接调 formatNumber。
// 当前偏好币种恒 USD(见 usePreferCurrency);多币种落地时只改 usePreferCurrency,调用点无感。
export function useDisplayValue(): (value: number) => string {
  const { unit, rate } = usePreferCurrency();
  const locale = useLocale();
  return (value: number) => formatNumber(value / rate, { unit, locale });
}
