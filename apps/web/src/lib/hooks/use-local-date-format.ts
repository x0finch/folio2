import { useMemo } from "react";
import { useLocale } from "use-intl";

// Manual activity times are wall-clock input, so format in the browser's time zone; the global
// formatter is pinned to UTC. `options` must be a stable (module-level) reference.
export function useLocalDateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = useLocale();
  return useMemo(() => new Intl.DateTimeFormat(locale, options), [locale, options]);
}
