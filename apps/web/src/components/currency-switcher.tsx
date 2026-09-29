import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { LogoAvatar, Select, SelectContent, SelectItem, SelectTrigger, toast } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { storeCurrency, usePreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { currencyPreferenceQuery } from "@/lib/queries/preferences";

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

// 切展示币种:先取到新币种的汇率,再把码写进 localStorage → 外壳换成新键的那份(已在缓存里)→
// 换汇率/格式。总览数据是 USD 计价的,不受影响。
// beUI motion Select。触发器**自渲染选中项**(不是 SelectValue)—— SelectValue 只吃字符串 label,
// 塞不下 logo;SelectTrigger 的 children 由消费侧给,故直接摆一个 CurrencyRow。不改 registry 件(ADR 0004)。
export function CurrencySwitcher() {
  const queryClient = useQueryClient();
  const t = useTranslations("Currency");
  const { currency } = usePreferCurrency();

  // **顺序是要点**:码是外壳 `useSuspenseQuery` 的键。先写码的话,新键没有数据 → 整个外壳挂起成
  // 骨架闪一下;先把新键取进缓存再写码,换键那一刻数据已经在手。
  //
  // **汇率还没有时服务端整体回退 USD**(读端点不出网,汇率由后台每小时暖,FOL-88)。码照样写进去 ——
  // 查询过期重取时汇率多半已经暖上,界面自己切过去;这一刻说一句,免得「点了没反应」。
  const setCurrency = useMutation({
    mutationFn: async (code: string) => {
      const preference = await queryClient.ensureQueryData(currencyPreferenceQuery(code));
      storeCurrency(code);
      if (preference.currency.code !== code) toast.message(t("noRateYet", { code }));
    },
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
