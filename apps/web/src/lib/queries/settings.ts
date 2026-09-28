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

// 设置域的读取入口 —— 与 `lib/server/settings` 的三个读取型 server fn 对应。

export const providerKeyStatusQuery = () =>
  queryOptions({
    queryKey: settingsKeys.providerKeys(),
    queryFn: () => getProviderKeyStatus(),
    staleTime: STALE_TIME.settings,
  });

// 名字带 `valuation` 是历史(第一个字段);它读的其实是 **user_settings 一整行** ——
// `valuationMode` + `hideBalances`(FOL-75/ADR 0052)。隐私 Provider 与外观卡的开关都从这份读
// 取 `hideBalances`,不另开第二份读(一行一份缓存)。
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

// 数据版本号(FOL-94,判据与比较在 `data-version.ts`)。`staleTime: 0`:它就是用来「每次都问」的 ——
// 回到页面(`refetchOnWindowFocus` 缺省开)与可见时每分钟一次。
export const dataVersionQuery = (): DataVersionOptions => ({
  queryKey: dataVersionKeys.all,
  queryFn: () => getDataVersion(),
  staleTime: 0,
  refetchInterval: POLL_INTERVAL.dataVersion,
});
