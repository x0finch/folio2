import { Database } from "@folio/db";
import { Effect } from "effect";

// 账户→Tag 关联整份返回,展示富化在客户端按 accountId 组装(同 memberships 的做法)。
export const handleListAccountTags = Effect.fn("listAccountTags")(function* () {
  return yield* (yield* Database).tags.listAccountLinks();
});
