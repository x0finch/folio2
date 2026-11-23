import { useCallback, useRef, useState } from "react";
import { getTokenPrice } from "@/lib/server/tokens";

// Imperative rather than a keyed `useQuery`: this fills an input the user may edit afterwards,
// so a cache update must never overwrite it, and cancellation is a stale-token, not a query
// lifecycle. `ticket` comes from the token picker and is passed through opaquely.
export function useTokenPrice() {
  const reqRef = useRef(0);
  const [busy, setBusy] = useState(false);

  // Invalidates the in-flight request so a late response can't overwrite a newer value.
  const cancel = useCallback(() => {
    reqRef.current++;
    setBusy(false);
  }, []);

  const fetchPrice = useCallback(async (ticket: string, onPrice: (unitPrice: number) => void) => {
    const reqId = ++reqRef.current;
    setBusy(true);
    try {
      const p = await getTokenPrice({ data: { ticket } });
      if (reqRef.current === reqId && p?.unitPrice != null) onPrice(p.unitPrice);
    } catch {
      // Price lookup is best-effort.
    } finally {
      // A superseded request must not clear the newer request's busy state.
      if (reqRef.current === reqId) setBusy(false);
    }
  }, []);

  return { fetchPrice, cancel, busy } as const;
}
