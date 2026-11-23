import { SPRING_PANEL } from "@folio/ui/lib/ease";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "./portal";

// Hover/tap detail panel portaled to <body>. Not beUI <Popover>: the trigger sits in a SwipeableList
// row (overflow-hidden) and the Popover panel is absolutely positioned, not portaled, so it would be
// clipped. Desktop opens on hover, touch on tap (browsers synthesize mouseenter) and closes on
// outside click; never gate the handlers on pointer media queries or touch tablets break.

const CLOSE_DELAY = 120;
const PANEL_W = 256; // matches w-64; used for left clamping and the flip threshold
const GAP = 8;
const FLIP_THRESHOLD = 220; // flip above the trigger when less space remains below
const OFFSET = 6; // entry offset (px) toward the trigger

export function HoverDetail({
  children,
  detail,
  className,
}: {
  children: ReactNode; // trigger content
  detail: ReactNode; // panel content
  className?: string; // trigger wrapper class (carries the row's flex layout)
}) {
  const reduce = useReducedMotion() ?? false;
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearTimer();
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - PANEL_W - GAP));
    // Not enough room below: anchor to the trigger top and flip up.
    if (window.innerHeight - r.bottom < FLIP_THRESHOLD) {
      setPos({ left, bottom: window.innerHeight - r.top + GAP });
    } else {
      setPos({ left, top: r.bottom + GAP });
    }
  }, [clearTimer]);

  const scheduleClose = useCallback(() => {
    clearTimer();
    closeTimer.current = setTimeout(() => setPos(null), CLOSE_DELAY);
  }, [clearTimer]);

  // While open, a pointerdown outside trigger and panel closes it (also how touch taps dismiss).
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      clearTimer();
      setPos(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [pos, clearTimer]);

  // Nothing to expand: render the trigger content only.
  if (!detail) return <div className={className}>{children}</div>;

  const flipped = pos?.bottom != null;
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/tap enhancement; details are also reachable via swipe edit */}
      <div ref={triggerRef} onMouseEnter={open} onMouseLeave={scheduleClose} className={className}>
        {children}
      </div>
      {/* Portal stays mounted so AnimatePresence can play the exit. */}
      <Portal>
        <AnimatePresence>
          {pos && (
            <motion.div
              key="hover-detail-panel"
              ref={panelRef}
              onMouseEnter={clearTimer}
              onMouseLeave={scheduleClose}
              initial={{ opacity: 0, scale: 0.96, y: flipped ? OFFSET : -OFFSET }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: flipped ? OFFSET : -OFFSET }}
              transition={reduce ? { duration: 0 } : SPRING_PANEL}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                transformOrigin: flipped ? "left bottom" : "left top",
              }}
              className="z-[60] w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
            >
              {detail}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
