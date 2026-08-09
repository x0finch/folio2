import { useQueryClient } from "@tanstack/react-query";
import { useLocale } from "use-intl";
import { writePreferenceCookie } from "../lib/cookies";
import { LOCALE_COOKIE } from "../lib/i18n/detect";
import type { Locale } from "../lib/i18n/messages";
import { invalidateFor } from "../lib/queries/refresh";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

// 切语言:写 cookie(SSR 下次可读)+ 定向刷新偏好域 → IntlProvider 换 locale。
// 顺带刷代币域 —— 法币选项的名字是服务端按请求 locale 本地化的(见刷新映射表那条)。
export function LocaleSwitcher() {
  const queryClient = useQueryClient();
  const locale = useLocale();
  function set(next: Locale) {
    if (next === locale) return;
    writePreferenceCookie(LOCALE_COOKIE, next);
    void invalidateFor(queryClient, "preference.locale");
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
