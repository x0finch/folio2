import { SUPPORTED_CURRENCIES } from "@folio/fx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { CURRENCY_COOKIE } from "../lib/currency";
import { usePreferCurrency } from "../lib/hooks/use-prefer-currency";

// 切展示币种:写 cookie(SSR 下次可读)+ router.invalidate() 重跑 _authed loader → 换汇率/格式。
// beUI motion Select;选项标签本地化(如 "USD 美元" / "USD Dollar"),crypto 附符号。
export function CurrencySwitcher() {
  const router = useRouter();
  const t = useTranslations("Currency");
  const { currency } = usePreferCurrency();

  function set(next: string) {
    if (next === currency.code) return;
    document.cookie = `${CURRENCY_COOKIE}=${next}; path=/; max-age=31536000`;
    router.invalidate();
  }

  const label = (code: string, symbol?: string) =>
    `${symbol ? `${symbol} ` : ""}${code} ${t(code)}`;

  return (
    <Select value={currency.code} onValueChange={set} className="w-40">
      <SelectTrigger aria-label="Display currency">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_CURRENCIES.map((c) => (
          <SelectItem key={c.code} value={c.code}>
            {label(c.code, c.symbol)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
