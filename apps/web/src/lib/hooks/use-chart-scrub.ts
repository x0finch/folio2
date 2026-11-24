import { useState } from "react";
import { useFormatter } from "use-intl";
import type { HistoryPoint } from "@/lib/core/history";

// A hook rather than a wrapper component: each header places the scrubbed value in its own layout.
export function useChartScrub() {
  const format = useFormatter();
  const [point, setPoint] = useState<HistoryPoint | null>(null);
  return {
    /** `null` = not scrubbing (show the live value). */
    point,
    label: point
      ? format.dateTime(new Date(point.t), {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null,
    /** `setState` is already stable; no useCallback needed. */
    onActive: setPoint,
  };
}
