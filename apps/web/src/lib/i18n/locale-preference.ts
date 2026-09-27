import { storedPreference } from "@/lib/hooks/stored-preference";
import { DEFAULT_LOCALE, pickLocale } from "./detect";

// 界面语言偏好:localStorage,缺省按浏览器语言(ADR 0049 补记 —— 文档是静态资源,没有服务端可读 cookie)。
const KEY = "folio_locale";

function browserLanguage(): string | null {
  return typeof navigator === "undefined" ? null : navigator.language;
}

// 静态壳是按 `DEFAULT_LOCALE` 渲的(构建期没有「用户」),补水那一帧也得是它;真值在补水后换上。
export const { write: storeLocale, useValue: useLocalePreference } = storedPreference(
  KEY,
  (raw) => pickLocale(raw, browserLanguage()),
  DEFAULT_LOCALE,
);

// 内联进 <head> 的脚本(在 React 之前执行,像 THEME_INIT_SCRIPT):首帧就把 `<html lang>` 设对。
// 闪屏那行「准备中」按它选语种(见 SPLASH_STYLE),读屏 / 断词 / 字体回退也跟着它走。
//
// 逻辑是 `pickLocale(localStorage, navigator.language)` 的手抄 —— 内联脚本导不进模块。
// 两边对不上由 tests/locale-preference.test.ts 逐个输入对照着钉住,别只改一边。
export const LOCALE_INIT_SCRIPT = `(function(){var v=null;try{v=localStorage.getItem('${KEY}');}catch(e){}var l=v==='en'||v==='zh'?v:((navigator.language||'').split(',')[0].trim().toLowerCase().indexOf('zh')===0?'zh':'${DEFAULT_LOCALE}');document.documentElement.lang=l;})();`;
