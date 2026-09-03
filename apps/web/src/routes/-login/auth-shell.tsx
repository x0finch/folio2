import { cn } from "@folio/ui";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { LocaleSwitcher } from "./locale-switcher";
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

      {/* 品牌固定左上角(复用侧栏的 Logo + folio 字标)。
          顶部偏移叠 safe-area-inset-top:PWA 独立窗口(viewport-fit=cover + black-translucent
          状态栏)下,刘海/状态栏不压品牌(与 app-shell 顶栏同法,root 不动)。
          额外常量取 0.5rem(比 app-shell 顶栏的 0.75rem 更紧):登录页没有顶栏那层毛玻璃底衬,
          状态栏与品牌之间是透明留白,同样的偏移会显得更空 → 收紧到贴着状态栏下方一点点。 */}
      <div className="absolute top-[calc(0.5rem_+_env(safe-area-inset-top))] left-4 z-20 flex items-center gap-2.5">
        <Logo className="size-6 shrink-0" />
        <span className="font-semibold text-lg tracking-tight">folio</span>
      </div>

      {/* 语言 / 主题固定右上角(同样叠 safe-area-inset-top,不被状态栏压;与品牌同一 0.5rem 偏移)。 */}
      <div className="absolute top-[calc(0.5rem_+_env(safe-area-inset-top))] right-4 z-20 flex items-center gap-4">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>

      {/* 前景内容居中(透明,不套卡片)。上下内边距叠安全区:内容偏高时不钻进状态栏/底部指示条。 */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 pt-[calc(1.5rem_+_env(safe-area-inset-top))] pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}
