"use client";

import { cn } from "@folio/ui";
import { useEffect, useRef, useState } from "react";

// Shared behaviour for a hover beUI Popover: raise z-index while open (the panel isn't portalled),
// hide the goo backdrop layers when closed (after the collapse spring), and pick `side` from the
// available viewport space. `measureRef` goes on the trigger (PopoverTrigger merges refs).

// Must be ≥ the beUI popover GOO_SPRING collapse time, or the collapsing panel loses its backdrop.
const POPOVER_COLLAPSE_MS = 400;

export function useHoverPopover() {
  const [open, setOpen] = useState(false);
  const [backdropHidden, setBackdropHidden] = useState(true);
  // Default "top": the closed panel still takes layout space, and "bottom" on the last row would
  // extend the document and leave blank space at the bottom.
  const [side, setSide] = useState<"top" | "bottom">("top");
  const anchor = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measureRef = (node: HTMLElement | null) => {
    anchor.current = node;
  };
  const onOpenChange = (next: boolean) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (next) {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setSide(rect.top > window.innerHeight - rect.bottom ? "top" : "bottom");
      setBackdropHidden(false);
    } else {
      hideTimer.current = setTimeout(() => setBackdropHidden(true), POPOVER_COLLAPSE_MS);
    }
    setOpen(next);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  return {
    side,
    onOpenChange,
    measureRef,
    // Behaviour only; layout classes are the caller's.
    rootClassName: cn(open && "z-50", backdropHidden && "[&>[aria-hidden]]:hidden"),
  };
}
