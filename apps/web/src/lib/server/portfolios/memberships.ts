import { Database } from "@folio/db";
import { Effect } from "effect";

// 该用户全部 账户→Portfolio 归属(账户页按选中 Portfolio 客户端过滤用 —— 账户页已加载全部账户,
// 拿归属表在客户端过滤即可、无需按选中重拉)。
export const handleListPortfolioMemberships = Effect.fn("listPortfolioMemberships")(function* () {
  return yield* (yield* Database).portfolios.listMemberships();
});
