import { useLocale } from "use-intl";
import { storeLocale } from "@/lib/i18n/locale-preference";
import type { Locale } from "@/lib/i18n/messages";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

// 切语言:写 localStorage → 根上的 IntlProvider 订阅着它,当场换 locale(ADR 0049 补记)。
// 法币选项的名字把语言放进了查询键,换语言即换键,不需要另外刷新。
export function LocaleSwitcher() {
  const locale = useLocale();

  function set(next: Locale) {
    if (next === locale) return;
    storeLocale(next);
  }
  return (
    <div className="flex gap-2 text-sm">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => set(o.value)}
          className={o.value === locale ? "text-foreground" : "text-muted-foreground"}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
