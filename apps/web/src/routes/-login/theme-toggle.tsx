import { Monitor, Moon, Sun } from "lucide-react";
import { type Theme, useMountedTheme } from "@/lib/hooks/use-theme";

// 主题切换：单 icon 循环 light → dark → system(icon 反映当前态)。选中态用 useMountedTheme(SSR 安全)。
// 从 login 页抽出，供 AuthShell(登录 / 锁屏)共用。
const THEME_ORDER: Theme[] = ["light", "dark", "system"];
const THEME_ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

export function ThemeToggle() {
  const { theme, setTheme } = useMountedTheme();
  const Icon = THEME_ICON[theme];
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  return (
    <button
      type="button"
      aria-label={`theme: ${theme}`}
      onClick={() => setTheme(next)}
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  );
}
