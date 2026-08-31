import { Database } from "@folio/db";
import { Effect } from "effect";
import { manualFiatRefs } from "@/lib/server/manual/store";
import { type PortfolioScope, scopedMembership } from "./scope";

// 手记法币身份 ref(FOL-54):tokenId → `fiat/issued:<CODE>`。只扫当前组合活跃 manual 账户,
// 浏览器合并总览时喂 `buildOverview` 的 `fiatRefs`。

export const handleGetFiatRefs = Effect.fn("getFiatRefs")(function* (data: PortfolioScope = {}) {
  const member = yield* scopedMembership(data.portfolioId);
  const accounts = (yield* (yield* Database).accounts.list()).filter((a) => member.has(a.id));
  const fiatRefs = yield* manualFiatRefs(accounts);
  return { fiatRefs: [...fiatRefs] as [string, string][] };
});
