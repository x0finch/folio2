import { useRef } from "react";
import {
  DEFAULT_TAB,
  KIND_TABS,
  type KindTab,
  pickShownTab,
} from "@/routes/_authed/-home/home-tabs";
import { useHomeViewState } from "@/routes/_authed/-home/view-state";

const TAB_SCROLL_MARGIN = 16; // px of margin kept on both sides when scrolling a tab into view

// Scrolls a tab (or +) fully into view in the horizontal strip. Hand-rolled: scrollIntoView also
// scrolls overflow-hidden ancestors and the page vertically.
export function revealTab(el: HTMLElement) {
  const strip = el.closest(".overflow-x-auto");
  if (!strip) return;
  const sr = strip.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.right + TAB_SCROLL_MARGIN > sr.right)
    strip.scrollLeft += er.right + TAB_SCROLL_MARGIN - sr.right;
  else if (er.left - TAB_SCROLL_MARGIN < sr.left)
    strip.scrollLeft -= sr.left - er.left + TAB_SCROLL_MARGIN;
}

export function useHomeTabSelection(pins: { id: string }[]) {
  // "tokens" / "perps" / "defi" or a pin id; held in component state (HomeViewStateProvider).
  const { tab: active, setTab } = useHomeViewState();
  // Skip no-op writes. Switching to a custom tab suspends (its data is fetched per pin); the
  // parent Suspense boundary handles it, so no startTransition.
  const selectTab = (v: string) => {
    if (v === active) return;
    setTab(v);
  };
  // `active` can briefly point at a pin not yet mounted (invalidate resolves before the new data
  // is visible), so render the last valid value to avoid flashing back to Tokens. This also falls
  // back to the default tab for a deleted / bogus pin id.
  const isKnownTab = (v: string) =>
    KIND_TABS.includes(v as KindTab) || pins.some((p) => p.id === v);
  const lastKnownActive = useRef<string>(DEFAULT_TAB);
  if (isKnownTab(active)) lastKnownActive.current = active;
  const shownActive = pickShownTab(active, lastKnownActive.current, isKnownTab);
  return { active, selectTab, shownActive };
}
