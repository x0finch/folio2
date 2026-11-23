import type { Locale } from "./messages";

// Pure (unit-testable) locale choice: user's pick, else browser language, else `en`. Shared by the browser
// (./locale-preference) and the server (validating the locale param), so it must not import anything one side lacks.
export const DEFAULT_LOCALE: Locale = "en";

function isLocale(v: string | undefined | null): v is Locale {
  return v === "en" || v === "zh";
}

export function pickLocale(
  chosen: string | undefined | null,
  browserLanguage: string | undefined | null,
): Locale {
  if (isLocale(chosen)) return chosen;
  // Primary subtag of the first language tag: zh* -> zh, else default; accepts Accept-Language and `navigator.language` shapes.
  const primary = browserLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (primary.startsWith("zh")) return "zh";
  return DEFAULT_LOCALE;
}
