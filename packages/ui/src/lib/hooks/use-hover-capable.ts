"use client";

import { useMediaQuery } from "./use-media-query";

/**
 * Returns true only on devices that have a true hover (mouse / trackpad).
 * Touch devices fire phantom `:hover` on tap that sticks until tap-elsewhere
 * — gate hover-only effects (scale lifts, magnetic pulls) behind this.
 */
export function useHoverCapable() {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}
