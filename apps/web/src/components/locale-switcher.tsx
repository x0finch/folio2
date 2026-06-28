import { useRouter } from "@tanstack/react-router";
import { useLocale } from "use-intl";
import { LOCALE_COOKIE } from "../lib/i18n/detect";
import type { Locale } from "../lib/i18n/messages";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

// 切语言:写 cookie(SSR 下次可读)+ router.invalidate() 重跑根 loader → IntlProvider 换 locale。
export function LocaleSwitcher() {
  const router = useRouter();
  const locale = useLocale();
  function set(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000`;
    router.invalidate();
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
