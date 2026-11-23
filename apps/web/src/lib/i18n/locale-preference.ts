import { storedPreference } from "@/lib/hooks/stored-preference";
import { DEFAULT_LOCALE, pickLocale } from "./detect";

// Stored in localStorage, defaulting to the browser language (static document: no server-readable cookie).
const KEY = "folio_locale";

function browserLanguage(): string | null {
  return typeof navigator === "undefined" ? null : navigator.language;
}

// The static shell is rendered with `DEFAULT_LOCALE` (no user at build time), so the hydration frame must match; the real value swaps in after.
export const { write: storeLocale, useValue: useLocalePreference } = storedPreference(
  KEY,
  (raw) => pickLocale(raw, browserLanguage()),
  DEFAULT_LOCALE,
);

// Inlined into <head> and run before React (like THEME_INIT_SCRIPT) so the first frame has the right `<html lang>`.
// Hand copy of `pickLocale(localStorage, navigator.language)` since inline scripts can't import modules;
// tests/locale-preference.test.ts pins both sides, so change them together.
export const LOCALE_INIT_SCRIPT = `(function(){var v=null;try{v=localStorage.getItem('${KEY}');}catch(e){}var l=v==='en'||v==='zh'?v:((navigator.language||'').split(',')[0].trim().toLowerCase().indexOf('zh')===0?'zh':'${DEFAULT_LOCALE}');document.documentElement.lang=l;})();`;
