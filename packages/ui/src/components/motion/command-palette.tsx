"use client";
// fork 自 beui.dev/components/blocks/command-palette:改造成【受控的通用外壳】——
// query/onQueryChange 由外部驱动(支持远程搜索),不做内建 fuzzy 过滤;结果行由 children 渲染。
// ⌘K 全局快捷键不在此(字段级 picker 用点击触发);仅 esc + 点遮罩关闭 + body scroll lock。

import { LoaderCircle, Search } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@folio/ui/lib/ease";
import { cn } from "@folio/ui/lib/utils";

const PANEL_SPRING = { type: "spring", stiffness: 560, damping: 40, mass: 0.5 } as const;

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  loading?: boolean;
  children: ReactNode;
  className?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  placeholder,
  loading,
  children,
  className,
}: CommandPaletteProps) {
  const [mounted, setMounted] = useState(false);
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <div
      aria-hidden={!open}
      className={cn("fixed inset-0 z-[100]", open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <motion.div
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: open ? 0.18 : 0.12, ease: EASE_OUT }}
        onClick={() => onOpenChange(false)}
        className={cn(
          "absolute inset-0 bg-background/5 [backdrop-filter:blur(12px)_saturate(140%)] [-webkit-backdrop-filter:blur(12px)_saturate(140%)]",
          open ? "pointer-events-auto" : "pointer-events-none",
        )}
      />
      <div className="pointer-events-none absolute inset-0 flex items-start justify-center p-4 pt-[18vh]">
        <motion.div
          role="dialog"
          aria-modal="true"
          initial={false}
          animate={{ opacity: open ? 1 : 0, y: open || reduce ? 0 : -8, scale: open || reduce ? 1 : 0.97 }}
          transition={reduce ? { duration: 0.1 } : open ? PANEL_SPRING : { duration: 0.12, ease: EASE_OUT }}
          className={cn(
            "w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl will-change-transform",
            open ? "pointer-events-auto" : "pointer-events-none",
            className,
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={placeholder}
              tabIndex={open ? 0 : -1}
              className="h-12 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
            {loading ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-block">
                ESC
              </kbd>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">{children}</div>
        </motion.div>
      </div>
    </div>,
    document.body,
  );
}
