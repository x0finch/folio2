import { queryOptions } from "@tanstack/react-query";
import { listAccountTags, listTags } from "@/lib/server/tags";
import { STALE_TIME } from "./constants";
import { tagKeys } from "./keys";

// 标签域的读取入口 —— 与 `lib/server/tags` 的两个读取型 server fn 对应。
// 这个域的读写在同一片里迁完(#415),所以 `staleTime` 当场就开。

/** 一份 Tag 定义 / 一份账户→Tag 关联。**从 server fn 推导**,同 `accounts.ts` 那两条。 */
export type TagList = Awaited<ReturnType<typeof listTags>>;
export type AccountTagLinks = Awaited<ReturnType<typeof listAccountTags>>;

// 两条都按组合各一份(ADR 0047):Tag 本来就归属 Portfolio,关联也只回当前组合的账户那些。
export const tagListQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: tagKeys.list(portfolioId),
    queryFn: () => listTags({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

export const accountTagLinksQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: tagKeys.accountLinks(portfolioId),
    queryFn: () => listAccountTags({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });
