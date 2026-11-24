import { useCallback, useEffect, useState } from "react";

// The <head> init script sets the class before hydration so dark mode never flashes white.
export type Theme = "light" | "dark" | "system";
const KEY = "theme";

export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||((t===null||t==='system')&&m);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

function getStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function setStoredTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

// Re-applies after hydration recovery / re-render wipes the class the <head> script set.
export function applyStoredTheme(): void {
  applyTheme(getStoredTheme());
}

// The stored theme isn't known during SSR; render "system" until mounted to avoid a mismatch.
// Use this for any "current theme" selection UI, not useTheme().theme.
export function useMountedTheme() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return { theme: mounted ? theme : ("system" as Theme), setTheme } as const;
}

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    setStoredTheme(t);
    setThemeState(t);
    applyTheme(t);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
