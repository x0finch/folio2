"use client";

import { useEffect, useState } from "react";
import { useFormatter, useNow } from "use-intl";

// The provider's `now` is frozen at page load, so fresh snapshots would render as "in 2 minutes",
// and `useNow({ updateInterval })` still starts stale on late mounts. Keep our own clock, seeded
// from the provider for SSR/hydration, and clamp to now since a snapshot can land between ticks.
const TICK_MS = 60_000;

export function useRelativeSyncedAt(): (timestampMs: number) => string {
  const format = useFormatter();
  // Only the SSR/hydration fallback; the live clock is below.
  const providerNow = useNow();
  const [clientNow, setClientNow] = useState<Date | null>(null);

  useEffect(() => {
    setClientNow(new Date());
    const timer = setInterval(() => setClientNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const now = clientNow ?? providerNow;
  return (timestampMs) => format.relativeTime(new Date(Math.min(timestampMs, now.getTime())), now);
}
