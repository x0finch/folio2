import { queryOptions } from "@tanstack/react-query";
import { listAccountTags, listTags } from "@/lib/server/tags";
import { STALE_TIME } from "./constants";
import { tagKeys } from "./keys";

// Tag-domain reads; reads and writes migrated together, so `staleTime` is on.

/** Tag definitions / account-tag links, inferred from the server fn (like `accounts.ts`). */
export type TagList = Awaited<ReturnType<typeof listTags>>;
export type AccountTagLinks = Awaited<ReturnType<typeof listAccountTags>>;

// Both are per portfolio: tags belong to a portfolio and links return only the current portfolio's accounts.
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
