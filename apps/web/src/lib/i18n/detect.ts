import type { Locale } from "./messages";

// 纯逻辑(可单测):定 locale —— cookie 优先 → Accept-Language 兜底 → 默认 en。
export const LOCALE_COOKIE = "folio_locale";
const DEFAULT: Locale = "en";

function isLocale(v: string | undefined | null): v is Locale {
  return v === "en" || v === "zh";
}

// 从 Cookie 头里取 folio_locale 的值(不依赖任何运行时,纯解析)。
export function readLocaleCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === LOCALE_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function pickLocale(
  cookieValue: string | undefined | null,
  acceptLanguage: string | undefined | null,
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  // Accept-Language: 取首个语言标签的主语言子标签;zh* → zh,其余 → 默认。
  const primary = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (primary.startsWith("zh")) return "zh";
  return DEFAULT;
}
