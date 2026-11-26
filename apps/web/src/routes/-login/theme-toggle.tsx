import { Monitor, Moon, Sun } from "@folio/ui/icons";
import { type Theme, useMountedTheme } from "@/lib/hooks/use-theme";

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
      className="flex text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon />
    </button>
  );
}
