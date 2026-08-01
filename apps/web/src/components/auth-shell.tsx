import { cn } from "@folio/ui";
import type { ReactNode } from "react";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

// 未进入 App 主体的全屏认证外壳,登录页与锁屏共用:背景层 + 左上品牌 + 右上语言/主题 + 居中内容。
// 背景各自传入(登录=虚化 hero,锁屏=磨砂 blur);className 覆盖外层定位(锁屏用 fixed 覆盖层)。
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

      {/* 品牌固定左上角(复用侧栏的 Logo + folio 字标)。 */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2.5">
        <Logo className="size-6 shrink-0" />
        <span className="font-semibold text-lg tracking-tight">folio</span>
      </div>

      {/* 语言 / 主题固定右上角。 */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-4">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>

      {/* 前景内容居中(透明,不套卡片)。 */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center p-6">
        {children}
      </div>
    </div>
  );
}
