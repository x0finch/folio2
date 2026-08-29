import { Effect } from "effect";
import { type Pending, servePrecomputed, type TabStripView, tabStripKey } from "./precompute";

// 首页 tab 条的读接口 —— **读 + 传,一次单键读**(ADR 0049 裁定 1)。
// 「有没有永续 / DeFi、自定义 Tab 叫什么」是同步收官那一刻算好的(`computeHomeTabStrip`);
// 这里不再富化、不再拆快照。tab 条**不吃 pin**(它本身就是「有哪些 pin」的答案),
// 所以一个组合一个键。

/** 读出去的形状 = tab 条本身,外加一个可选的「还在重算」。既有字段一个都没动。 */
type HomeTabStrip = TabStripView & Pending;

// 空态 = 「还没算过」,逐字是全新用户那一支的形状(零账户、零 pin)。每次现造一个新对象。
const emptyTabStrip = (): HomeTabStrip => ({
  hasAccounts: false,
  hasPerps: false,
  hasDefi: false,
  pins: [],
});

export const handleGetHomeTabStrip = Effect.fn("getHomeTabStrip")(function* (
  userId: string,
  data: { portfolioId?: string },
) {
  return yield* servePrecomputed(userId, data, tabStripKey, emptyTabStrip);
});
