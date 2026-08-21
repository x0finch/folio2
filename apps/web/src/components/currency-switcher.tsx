import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { LogoAvatar, Select, SelectContent, SelectItem, SelectTrigger } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { usePreferCurrency } from "../lib/hooks/use-prefer-currency";
import { invalidateFor } from "../lib/queries/refresh";
import { setCurrencyPreference } from "../lib/server/preferences";

// 一项/触发器共用的行内容:logo + 本地化标签(如 "USD 美元" / "USD Dollar",crypto 附符号)。
// logo 是 base64 data URI,内嵌在 SUPPORTED_CURRENCIES(法币 CMC / crypto CoinGecko)。
function CurrencyRow({
  code,
  name,
  logo,
  symbol,
}: {
  code: string;
  name: string;
  logo: string;
  symbol?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LogoAvatar src={logo} fallback={code} size="sm" />
      <span className="truncate">{`${symbol ? `${symbol} ` : ""}${code} ${name}`}</span>
    </span>
  );
}

// 切展示币种:写 cookie(SSR 下次可读)+ 定向刷新偏好域 → 换汇率/格式。总览数据是 USD 计价的,不受影响。
// beUI motion Select。触发器**自渲染选中项**(不是 SelectValue)—— SelectValue 只吃字符串 label,
// 塞不下 logo;SelectTrigger 的 children 由消费侧给,故直接摆一个 CurrencyRow。不改 registry 件(ADR 0004)。
export function CurrencySwitcher() {
  const queryClient = useQueryClient();
  const t = useTranslations("Currency");
  const { currency } = usePreferCurrency();

  // cookie 由服务端写(见 lib/server/preferences):客户端设不上 HttpOnly/SameSite/Secure。
  const setCurrency = useMutation({
    mutationFn: (code: string) => setCurrencyPreference({ data: { code } }),
    onSuccess: () => invalidateFor(queryClient, "preference.currency"),
  });

  function set(next: string) {
    if (next === currency.code) return;
    setCurrency.mutate(next);
  }

  return (
    <Select value={currency.code} onValueChange={set} className="w-40">
      {/* rounded-full!:触发器做成全圆角胶囊(与设置页主题/语言 pill 一致)。beUI Select 的圆角由
          framer inline style 控(不改 registry 件),故消费侧用 important 覆盖。
          bg-muted dark:bg-background:触发器底色对齐设置页分段器轨道(亮色 muted / 暗色 background)。 */}
      <SelectTrigger
        aria-label="Display currency"
        className="rounded-full! bg-muted dark:bg-background"
      >
        <CurrencyRow
          code={currency.code}
          name={t(currency.code)}
          logo={currency.logo}
          symbol={currency.symbol}
        />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_CURRENCIES.map((c) => (
          <SelectItem key={c.code} value={c.code}>
            <CurrencyRow code={c.code} name={t(c.code)} logo={c.logo} symbol={c.symbol} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
