// 深色模式:切 <html> 的 .dark 类(@folio/ui 已备明暗 token)。三态:light / dark / system。
// 无闪烁:首屏由 __root <head> 的内联脚本(THEME_INIT_SCRIPT)在 hydration 前就设好类。
// 运行时切换 / 持久化 / system 跟随的 hook 见 hooks/use-theme;本模块只放脚本 + localStorage/DOM 副作用原语。
export type Theme = "light" | "dark" | "system";
const KEY = "theme";

// 内联进 <head> 的初始化脚本(在 React 之前执行,避免深色闪白)。
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||((t===null||t==='system')&&m);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export function getStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

// 挂载后从 localStorage 重放主题 —— 兜底 hydration recovery / 重渲染把 <head> 脚本设的 .dark 冲掉的情况
//(root 用 useLayoutEffect 调用)。首帧无闪仍由 THEME_INIT_SCRIPT 负责;本函数只在此后维稳。
export function applyStoredTheme(): void {
  applyTheme(getStoredTheme());
}
