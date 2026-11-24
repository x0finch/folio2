import { Popover, PopoverContent, PopoverTrigger, useMediaQuery } from "@folio/ui";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "@/components/portal";
import { revealTab } from "./selection";

const PIN_PANEL_W = 240; // w-56 + p-2
const PIN_PANEL_H = 340; // approximate panel height, decides whether it opens up or down
const VIEW_INSET = 8;
const GOO_COLLAPSE_MS = 400; // beUI goo collapse spring lasts ~0.32s; unmount after it finishes
const HIDE_SOON_MS = 140;

// Mount closed, open on the next tick, and unmount only after the collapse finishes: (1) beUI
// Popover mounted with open=true races its size-measuring re-render against the opening spring and
// stays clipped at p=0; (2) after closing, the goo pill would stay over the portaled tab.
function useDeferredOpen(open: boolean) {
  const [mounted, setMounted] = useState(false);
  const [openDeferred, setOpenDeferred] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setOpenDeferred(false);
    const t = setTimeout(() => setMounted(false), GOO_COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (open && mounted) setOpenDeferred(true);
  }, [open, mounted]);
  return { mounted, openDeferred };
}

// Align left if there's room on the right, else right; open down if there's room below, else up (viewport-based, the layer is fixed).
function placePanel(
  rect: DOMRect,
  view: { width: number; height: number },
): { align: "start" | "end"; side: "top" | "bottom" } {
  return {
    align: rect.left + PIN_PANEL_W <= view.width - VIEW_INSET ? "start" : "end",
    side: view.height - rect.bottom > PIN_PANEL_H || rect.top < PIN_PANEL_H ? "bottom" : "top",
  };
}

// Manage panel for pin / +: the whole beUI Popover renders inside a Portal (goo motion kept),
// fixed over the trigger and above the hero, so the horizontal scroll container neither clips it nor
// grows a scrollbar. The trigger renders a pixel-identical ghost of the real tab and must have a
// real size (Popover root is h-full w-full; 0x0 would make the goo clip start empty). Closed, the
// layer ignores pointers so clicks reach the real tab.
function PinPortalPopover({
  open,
  rect,
  ghost,
  onRequestClose,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  open: boolean;
  rect: DOMRect | null;
  ghost: ReactNode; // visual copy of the real tab, so the goo pill sits under the text as in native beUI
  onRequestClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const { mounted, openDeferred } = useDeferredOpen(open);
  if (!rect || !mounted) return null;
  const { align, side } = placePanel(rect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pure overlay container; interactive items are inside the panel and the tab itself is keyboard reachable */}
      <div
        style={{
          position: "fixed",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: 60,
          pointerEvents: open ? "auto" : "none", // closed: don't block clicks on the tab underneath
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Popover
          open={openDeferred}
          trigger="click"
          side={side}
          align={align}
          // 16 = half the 32px tab pill: beUI sizes the goo pill radius as min(tH/2, panelRadius),
          // so 16 matches the ghost's corners exactly.
          panelRadius={16}
          onOpenChange={(next) => {
            if (!next) onRequestClose(); // outside click / Esc / trigger click all flow back to the caller
          }}
          // h-full w-full: root fills the fixed box so the trigger measures a real size.
          className="h-full w-full"
        >
          <PopoverTrigger>
            {/* The ghost sits above the goo layer (z-[-1]), as in native beUI: the pill stays under the text. */}
            <span className="flex h-full w-full items-center justify-center">{ghost}</span>
          </PopoverTrigger>
          <PopoverContent className="p-2">{children}</PopoverContent>
        </Popover>
      </div>
    </Portal>
  );
}

function useHoverDelay(onHide: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => () => clear(), [clear]);
  const hideSoon = useCallback(() => {
    clear();
    timer.current = setTimeout(() => onHideRef.current(), HIDE_SOON_MS);
  }, [clear]);
  return { clear, hideSoon };
}

// The layer is fixed, so it closes when the trigger moves away. Two filters keep it from closing
// spuriously: a scroll in a container not containing the trigger (the picker's own scroll) is
// ignored, and so is a scroll where the trigger hasn't actually moved (revealTab's own scroll
// event arrives async). Resize always closes.
function useCloseOnDetach(
  open: boolean,
  rect: DOMRect | null,
  anchorRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && anchorRef.current && !t.contains(anchorRef.current)) return;
      const r = anchorRef.current?.getBoundingClientRect();
      if (r && rect && Math.abs(r.left - rect.left) < 1 && Math.abs(r.top - rect.top) < 1) return;
      closeRef.current();
    };
    const onResize = () => closeRef.current();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, rect, anchorRef]);
}

// Opens only if gateOpen passes: a pin must be selected first (first click only selects); + opens
// on first trigger. On desktop an already-selected pin also opens on hover and closes after a short delay.
function usePinPanel(canHover: boolean, gateOpen: () => boolean) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const { clear, hideSoon } = useHoverDelay(close);
  const closeNow = useCallback(() => {
    clear();
    close();
  }, [clear, close]);
  useCloseOnDetach(open, rect, anchorRef, closeNow);

  const show = () => {
    clear();
    const a = anchorRef.current;
    if (a) revealTab(a); // scroll a half-clipped trigger into view first, else the fixed layer hovers at unclipped coordinates
    const r = a?.getBoundingClientRect();
    if (r) setRect(r);
    setOpen(true);
  };
  const hoverProps = canHover
    ? {
        onMouseEnter: () => {
          if (gateOpen()) show(); // unselected pins don't open on hover
        },
        onMouseLeave: hideSoon,
      }
    : {};
  const onClick = () => {
    if (open) closeNow();
    else if (gateOpen()) show(); // isActive is still stale on the first (selecting) click
  };
  return { anchorRef, open, rect, close: closeNow, hideSoon, clear, hoverProps, onClick };
}

// Single entry: wraps the trigger and owns anchor, hover, open state, ghost and layer. Never opens
// when `gate` fails or when disabled.
export function PinPanel({
  gate = true,
  disabled = false,
  ghost,
  children,
  panel,
}: {
  gate?: boolean;
  disabled?: boolean;
  ghost: ReactNode;
  children: ReactNode;
  panel: (close: () => void) => ReactNode;
}) {
  const canHover = useMediaQuery("(hover: hover)");
  const p = usePinPanel(canHover, () => !disabled && gate);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the inner trigger is the keyboard-reachable element; this layer only carries hover/tap reveal
    // biome-ignore lint/a11y/useKeyWithClickEvents: same: selection and panel items are keyboard reachable, this is only a touch-tap wrapper
    <span
      ref={p.anchorRef as RefObject<HTMLSpanElement>}
      className="inline-flex"
      onClick={p.onClick}
      {...p.hoverProps}
    >
      {children}
      <PinPortalPopover
        open={p.open}
        rect={p.rect}
        ghost={ghost}
        onRequestClose={p.close}
        onMouseEnter={canHover ? p.clear : undefined}
        onMouseLeave={canHover ? p.hideSoon : undefined}
      >
        {panel(p.close)}
      </PinPortalPopover>
    </span>
  );
}
