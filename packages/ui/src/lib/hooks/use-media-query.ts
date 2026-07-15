"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media query. First render returns false (no window on the server);
 * after mount it reflects the real match and subscribes to changes. Use for
 * layout that switches on viewport/pointer capability.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}
