import { queryOptions } from "@tanstack/react-query";
import { getCurrencyPreference } from "@/lib/server/preferences";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { preferenceKeys } from "./keys";

// 偏好域的读取入口。**只剩展示币种的汇率**:币种码与界面语言都存在浏览器里(localStorage,
// ADR 0049 补记),读它们不需要查询 —— 见 lib/hooks/use-prefer-currency 与 lib/i18n/locale-preference。
//
// 码进查询键:切币种 = 换一把键,不是刷同一把键。切换器先把新键的数据取到手再写码
// (见 components/currency-switcher),外壳的 `useSuspenseQuery` 换键时就不会挂起成骨架。
export const currencyPreferenceQuery = (code: string) =>
  queryOptions({
    queryKey: preferenceKeys.currency(code),
    queryFn: () => getCurrencyPreference({ data: { code } }),
    staleTime: STALE_TIME.settings,
    // 外壳靠它才画得出来,所以**不放弃**(同 portfolioListQuery 的理由)。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });
