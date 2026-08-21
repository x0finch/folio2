import { queryOptions } from "@tanstack/react-query";
import { getDataStats, getProviderKeyStatus, getValuationSettings } from "../server/settings";
import { STALE_TIME } from "./constants";
import { settingsKeys } from "./keys";

// 设置域的读取入口 —— 与 `lib/server/settings` 的三个读取型 server fn 对应。

export const providerKeyStatusQuery = () =>
  queryOptions({
    queryKey: settingsKeys.providerKeys(),
    queryFn: () => getProviderKeyStatus(),
    staleTime: STALE_TIME.settings,
  });

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
