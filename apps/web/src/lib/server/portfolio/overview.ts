import { Effect } from "effect";
import type { OverviewView } from "./overview-model";
import { overviewKey, type Pending, servePrecomputed } from "./precompute";
import type { PortfolioScope } from "./scope";

// 组合总览的读接口 —— **读 + 传,一次单键读**(ADR 0049 裁定 1)。总额、持仓聚合、两个小计
// 都是同步收官那一刻算好的;算它的那台机器(键、水位线、补算、维度)在 ./precompute。

/** 读出去的形状 = 总览本身,外加一个可选的「还在重算」。既有字段一个都没动。 */
type PortfolioOverview = OverviewView & Pending;

// 空态 = 「还没算过」,而它逐字就是「全新用户」那一支的形状 —— 前端早就渲染得了。
// **每次现造一个新对象**:调用方拿到的是响应体,共用一份常量的话,任何一处顺手往上挂个
// 字段都会污染下一次请求。
const emptyOverview = (): PortfolioOverview => ({
  holdings: [],
  sections: [],
  accountTotals: [],
  totalUsd: 0,
  holdingsSubtotal: 0,
  defiSubtotal: 0,
  pricesStale: false,
});

/**
 * `userId` 显式收一次,理由与 24h 盈亏那两条同一个:补算要**另起一次装配**跑在 `waitUntil`
 * 上(与这次请求的响应无关的另一个程序),而 `runEffect` 刻意不把 userId 交给 handler。
 * 装配点因此走 `runForUser`(见 ./index)。
 */
export const handleGetPortfolioOverview = Effect.fn("getPortfolioOverview")(function* (
  userId: string,
  data: PortfolioScope,
) {
  return yield* servePrecomputed(userId, data, overviewKey, emptyOverview);
});
