import { useCallback, useEffect, useState } from "react";
import { applyTheme, getStoredTheme, setStoredTheme, type Theme } from "../lib/theme";

// SSR 安全的主题选中态。theme 存于 localStorage → SSR 只得 "system",若首帧直接用 useTheme().theme
// 会与 SSR 不一致而触发 hydration mismatch。挂载前统一按 "system" 渲染(与 SSR 齐),挂载后再显真实值。
// 凡展示"当前主题"选中态(segmented / icon 组)都用它,不要直接用 useTheme().theme。
export function useMountedTheme() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return { theme: mounted ? theme : ("system" as Theme), setTheme } as const;
}

// 运行时主题切换 + 持久化 + system 跟随。首帧无闪由 <head> 的 THEME_INIT_SCRIPT 负责(见 lib/theme)。
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    setStoredTheme(t);
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
