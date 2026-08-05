"use client";
// beui.dev/components/motion/button — fork:新增 `destructive` 变体 + `buttonVariants` 辅助(供
// 非按钮元素如导出链接复用样式)。@/ 别名已改写为 @folio/ui/*。
// **有 fork 就不能直接 `shadcn add` 覆盖**(会把上面两样冲掉)。所以上游后来的改动是手抄进来的:
// ripple 的 id 提到 updater 外、初始 scale 0 → 0.05。下次同步照此逐条抄。

import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { forwardRef, type PointerEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { EASE_OUT, SPRING_PRESS } from "@folio/ui/lib/ease";
import { useHoverCapable } from "@folio/ui/lib/hooks/use-hover-capable";
import { cn } from "@folio/ui/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressScale?: number;
  /** Spawn a Material-style ripple from the press point. Off by default. */
  ripple?: boolean;
  children?: ReactNode;
}

type Ripple = { id: number; x: number; y: number; size: number };

const BASE =
  "inline-flex items-center justify-center font-medium select-none transition-colors disabled:pointer-events-none disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "border border-border bg-card text-foreground hover:border-border",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-primary/5",
  outline: "border border-border bg-transparent text-foreground hover:bg-primary/5",
  destructive: "bg-destructive text-white hover:bg-destructive/90",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-full",
  md: "h-10 px-5 text-sm gap-2 rounded-full",
  lg: "h-12 px-6 text-base gap-2 rounded-full",
  icon: "h-8 w-8 rounded-lg",
};

/** 样式辅助:给非按钮元素(如 `<a download>`)复用胶囊按钮外观。 */
export function buttonVariants({
  variant = "primary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(BASE, VARIANT_CLASS[variant], SIZE_CLASS[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", pressScale = 0.93, ripple = false, className, children, onPointerDown, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const nextId = useRef(0);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (ripple && !reduce) {
        const rect = event.currentTarget.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2;
        // id 在 updater 外取:updater 在 StrictMode 下会跑两遍,放里面会白烧一个 id。
        const id = nextId.current++;
        setRipples((prev) => [
          ...prev,
          { id, x: event.clientX - rect.left, y: event.clientY - rect.top, size },
        ]);
      }
      onPointerDown?.(event);
    },
    [ripple, reduce, onPointerDown],
  );

  return (
    <motion.button
      ref={ref}
      type="button"
      whileTap={reduce ? undefined : { scale: pressScale }}
      whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
      transition={SPRING_PRESS}
      onPointerDown={handlePointerDown}
      className={cn(BASE, ripple && "relative overflow-hidden", VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      {...rest}
    >
      {ripple && !reduce ? (
        <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          <AnimatePresence>
            {ripples.map((r) => (
              <motion.span
                key={r.id}
                className="absolute rounded-full bg-current"
                style={{ left: r.x, top: r.y, width: r.size, height: r.size, x: "-50%", y: "-50%" }}
                initial={{ scale: 0.05, opacity: 0.3 }}
                animate={{ scale: 1, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.6, ease: EASE_OUT }}
                onAnimationComplete={() => setRipples((prev) => prev.filter((x) => x.id !== r.id))}
              />
            ))}
          </AnimatePresence>
        </span>
      ) : null}
      {children}
    </motion.button>
  );
});
