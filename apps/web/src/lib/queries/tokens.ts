import { queryOptions } from "@tanstack/react-query";
import { listFiatOptions, listTokenCatalogue, listTokens } from "@/lib/server/tokens";
import { STALE_TIME } from "./constants";
import { tokenKeys } from "./keys";

// 代币域的读取入口(选币下拉的三条)。
//
// **`getTokenPrice` / `refreshTokenPrices` 故意不在这里。** 它们是事件里发生一次的取数 ——
// 选完币回填市价、展示时批量补价 —— 不是「这一格声明它要什么数据」。把它们塞成查询要么按票号
// 炸出一堆 key、要么拆掉「一整批合成一次请求」这个性质;CODING.md 那条「取数走 useQuery」
// 本来就给这种真副作用留了口子(见 token-combobox 里那段注释)。

export const tokenCatalogueQuery = () =>
  queryOptions({
    queryKey: tokenKeys.catalogue(),
    queryFn: () => listTokenCatalogue(),
    staleTime: STALE_TIME.catalogue,
  });

export const fiatOptionsQuery = () =>
  queryOptions({
    queryKey: tokenKeys.fiatOptions(),
    queryFn: () => listFiatOptions(),
    staleTime: STALE_TIME.catalogue,
  });

export const tokenSearchQuery = (query: string) =>
  queryOptions({
    queryKey: tokenKeys.search(query),
    queryFn: () => listTokens({ data: { query } }),
    staleTime: STALE_TIME.search,
  });
