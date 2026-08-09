import { queryOptions } from "@tanstack/react-query";
import { getCurrencyPreference, getLocalePreference } from "../server/preferences";
import { STALE_TIME } from "./constants";
import { preferenceKeys } from "./keys";

// 偏好域的读取入口。两者都是**读 cookie**(展示币种还带上当前汇率),切换时写 cookie + 定向刷新。

export const currencyPreferenceQuery = () =>
  queryOptions({
    queryKey: preferenceKeys.currency(),
    queryFn: () => getCurrencyPreference(),
    staleTime: STALE_TIME.settings,
  });

export const localePreferenceQuery = () =>
  queryOptions({
    queryKey: preferenceKeys.locale(),
    queryFn: () => getLocalePreference(),
    staleTime: STALE_TIME.settings,
  });
