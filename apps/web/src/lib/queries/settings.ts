import { queryOptions } from "@tanstack/react-query";
import {
  getDataStats,
  getDataVersion,
  getProviderKeyStatus,
  getValuationSettings,
} from "@/lib/server/settings";
import { POLL_INTERVAL, STALE_TIME } from "./constants";
import type { DataVersionOptions } from "./data-version";
import { dataVersionKeys, settingsKeys } from "./keys";

export const providerKeyStatusQuery = () =>
  queryOptions({
    queryKey: settingsKeys.providerKeys(),
    queryFn: () => getProviderKeyStatus(),
    staleTime: STALE_TIME.settings,
  });

// Named `valuation` for history, but it reads the whole user_settings row (`valuationMode` + `hideBalances`); the privacy
// provider and the appearance card read `hideBalances` from this same cache entry.
export const valuationSettingsQuery = () =>
  queryOptions({
    queryKey: settingsKeys.valuation(),
    queryFn: () => getValuationSettings(),
    staleTime: STALE_TIME.settings,
  });

export const dataStatsQuery = () =>
  queryOptions({
    queryKey: settingsKeys.dataStats(),
    queryFn: () => getDataStats(),
    staleTime: STALE_TIME.settings,
  });

// Polled on purpose: on window focus and once a minute while visible; `staleTime` (`STALE_TIME.dataVersion`) is only a few-second dedupe window.
export const dataVersionQuery = (): DataVersionOptions => ({
  queryKey: dataVersionKeys.all,
  queryFn: () => getDataVersion(),
  staleTime: STALE_TIME.dataVersion,
  refetchInterval: POLL_INTERVAL.dataVersion,
});
