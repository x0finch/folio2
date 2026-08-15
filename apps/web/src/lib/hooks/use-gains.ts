import { toast } from "@folio/ui";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import type { PortfolioGains } from "../gain-merge";
import type { PinScopeKey } from "../queries/keys";
import { portfolioGainsQuery } from "../queries/portfolio";

// 24h 盈亏那条读的**唯一入口**(#488)。
//
// **为什么要有这么个 hook,而不是各处自己 `useQuery`**:两件事,都不是风格问题。
//
// ① **请求分拍就是瀑布。** #488 的贯穿决定写着「渲染分拍,请求不分拍 —— 任何『上一拍回来才发
//    下一拍』的瀑布都是错的」。盈亏原先写在 `KindContent` / `PinContent` / `HeroIsland` 里,
//    而这三个组件都先 `useSuspenseQuery(总览)` —— 组件在总览回来之前根本不挂载,于是盈亏
//    只能等总览。首屏默认组合靠 loader 预踢掩盖了这一点,但**切组合、点开自定义 Tab** 时
//    loader 不重跑,盈亏就实打实排在总览后面。
//    治法是把这个 hook 也在**不挂起的祖先**里调一次:react-query 按 key 去重,祖先那次负责
//    「什么时候发」,叶子那次负责「读」,同一个请求。
//
// ② **贴合的三行代码原先在两处逐字重复**(`useQuery` + `attachSectionGains` + `attachHoldingGains`)。
//
// 失败提示见 `useGainsErrorNotice` —— 只在一处响,不是每个消费方各弹一次。
export function useGains(portfolioId: string, pin?: PinScopeKey): UseQueryResult<PortfolioGains> {
  return useQuery(portfolioGainsQuery(portfolioId, pin));
}

/**
 * 盈亏拉失败时的那**一处**提示(#488 票 5)。
 *
 * 分开成一个 hook 而不是塞进 `useGains`:`useGains` 会被同一屏调用好几次(祖先负责发、叶子
 * 负责读),提示写在里面就会一次失败弹好几条。这个只在壳里调一次。
 *
 * 列表与总净值不受影响 —— 它们来自另一条读,失败的只是盈亏,各盈亏位落成破折号。
 */
export function useGainsErrorNotice(isError: boolean): void {
  const t = useTranslations("Overview");
  const shown = useRef(false);
  useEffect(() => {
    if (!isError) {
      // 恢复了就把闸门放回去 —— 下一次真失败还该说一声。
      shown.current = false;
      return;
    }
    if (shown.current) return;
    shown.current = true;
    toast.error(t("gainsFailed"));
  }, [isError, t]);
}
