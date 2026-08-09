import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "use-intl";
import type { Locale } from "../lib/i18n/messages";
import { invalidateFor } from "../lib/queries/refresh";
import { setLocalePreference } from "../lib/server/preferences";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

// 切语言:写 cookie(SSR 下次可读)+ 定向刷新偏好域 → IntlProvider 换 locale。
// 顺带刷代币域 —— 法币选项的名字是服务端按请求 locale 本地化的(见刷新映射表那条)。
export function LocaleSwitcher() {
  const queryClient = useQueryClient();
  const locale = useLocale();
  const setLocale = useMutation({
    mutationFn: (next: Locale) => setLocalePreference({ data: { locale: next } }),
    onSuccess: () => invalidateFor(queryClient, "preference.locale"),
  });

  function set(next: Locale) {
    if (next === locale) return;
    setLocale.mutate(next);
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
