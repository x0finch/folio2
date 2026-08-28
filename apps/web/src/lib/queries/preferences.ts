import { queryOptions } from "@tanstack/react-query";
import { getCurrencyPreference, getLocalePreference } from "@/lib/server/preferences";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { preferenceKeys } from "./keys";

// 偏好域的读取入口。两者都是**读 cookie**(展示币种还带上当前汇率),切换时写 cookie + 定向刷新。

export const currencyPreferenceQuery = () =>
  queryOptions({
    queryKey: preferenceKeys.currency(),
    queryFn: () => getCurrencyPreference(),
    staleTime: STALE_TIME.settings,
    // 外壳靠它才画得出来,所以**不放弃**(同 portfolioListQuery 的理由)。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

export const localePreferenceQuery = () =>
  queryOptions({
    queryKey: preferenceKeys.locale(),
    queryFn: () => getLocalePreference(),
    staleTime: STALE_TIME.settings,
  });
