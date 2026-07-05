import { useCallback, useEffect, useState } from "react";

// 深色模式:切 <html> 的 .dark 类(@folio/ui 已备明暗 token)。三态:light / dark / system。
// 无闪烁:首屏由 __root <head> 的内联脚本(THEME_INIT_SCRIPT)在 hydration 前就设好类;
// 本模块负责运行时切换 + 持久化 + system 跟随。
export type Theme = "light" | "dark" | "system";
const KEY = "theme";

// 内联进 <head> 的初始化脚本(在 React 之前执行,避免深色闪白)。
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||((t===null||t==='system')&&m);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export function getStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
    applyTheme(t);
  }, []);

  // theme==="system" 时跟随系统变化实时切换。
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
