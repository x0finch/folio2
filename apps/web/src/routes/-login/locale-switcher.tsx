import { useLocale } from "use-intl";
import { storeLocale } from "@/lib/i18n/locale-preference";
import type { Locale } from "@/lib/i18n/messages";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

// Locale lives in localStorage; fiat option names include it in their query key, so no refetch.
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
