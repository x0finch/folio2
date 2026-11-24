import { cn } from "@folio/ui";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./theme-toggle";

// Full-screen auth frame shared by the login page and the lock screen.
export function AuthShell({
  background,
  className,
  children,
}: {
  background?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative min-h-screen w-full overflow-hidden", className)}>
      {background}

      {/* Offset by safe-area-inset-top so the iOS status bar doesn't cover it; 0.5rem (tighter
          than app-shell's 0.75rem) since there's no frosted top bar behind it. */}
      <div className="absolute top-[calc(0.5rem_+_env(safe-area-inset-top))] left-4 z-20 flex items-center gap-2.5">
        <Logo className="size-6 shrink-0" />
        <span className="font-semibold text-lg tracking-tight">folio</span>
      </div>

      <div className="absolute top-[calc(0.5rem_+_env(safe-area-inset-top))] right-4 z-20 flex items-center gap-4">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 pt-[calc(1.5rem_+_env(safe-area-inset-top))] pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}
