"use client";
// 全局 toast 出口:命令式 `toast`(逻辑在 toast-store)+ 挂载一次的 <Toaster>。
// 消费端 `import { toast, Toaster } from "@folio/ui"`,调用点与 sonner 时代零改。

import { AlertCircle, Bell, Check, Info, LoaderCircle, type LucideIcon, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@folio/ui/lib/utils";
import { type AnimatedToast, AnimatedToastStack, type ToastStatus } from "./animated-toast-stack";
import { getServerSnapshot, getSnapshot, remove, subscribe, toast } from "./toast-store";

export { toast };

// 自渲染 toast 内容(经 vendored stack 暴露的 renderToast prop,不改 kernel)。
// 换掉默认渲染的原因(#123):默认行是 `items-start`,单行文案中线偏上、与 spinner/关闭钮不齐;
// 且默认把标题包在内层 AnimatePresence(mode="popLayout")里,同步进度 toast 每刻更新标题 → key 频繁
// 更替 → popLayout 退场件堆积不回收 + 入场 y 位移动画卡在 y=8,任何基于布局的居中都被这个 transform 顶偏。
// 这里用一行 `items-center` 的纯 flex + 纯 <p>(无内层动效/transform),单/多行都稳稳居中;
// li 级的入退场与拖拽消除仍由 vendored 承载。图标状态映射按 vendored 复刻一份(未导出,glue 层小抄)。
const STATUS_ICON: Record<ToastStatus, LucideIcon> = {
  neutral: Bell,
  info: Info,
  loading: LoaderCircle,
  success: Check,
  error: AlertCircle,
};
const STATUS_CLASS: Record<ToastStatus, string> = {
  neutral: "text-muted-foreground bg-primary/[0.05]",
  info: "text-primary bg-primary/10",
  loading: "text-primary bg-primary/10",
  success: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400",
  error: "text-destructive bg-destructive/10",
};

function renderToast(t: AnimatedToast) {
  const status = t.status ?? "neutral";
  const Icon = STATUS_ICON[status];
  const canDismiss = t.dismissible !== false;
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          STATUS_CLASS[status],
        )}
      >
        <Icon className={cn("h-3.5 w-3.5", status === "loading" && "animate-spin")} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5 text-foreground">{t.title}</p>
        {t.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
            {t.description}
          </p>
        ) : null}
        {t.action ? (
          <button
            type="button"
            onClick={() => t.action?.onClick(t)}
            className="mt-2 inline-flex h-7 items-center rounded-full bg-primary/[0.06] px-3 text-xs font-medium text-foreground transition-colors hover:bg-primary/[0.1]"
          >
            {t.action.label}
          </button>
        ) : null}
      </div>

      {canDismiss ? (
        <button
          type="button"
          onClick={() => remove(t.id)}
          aria-label="Dismiss toast"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/[0.06] hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <AnimatedToastStack
      toasts={list}
      onDismiss={remove}
      position="bottom-right"
      placement="fixed"
      renderToast={renderToast}
    />
  );
}
