import { Effect } from "effect";
import type { Gain } from "./gain-24h";
import type { OverviewView } from "./overview-model";
import { accountGainKey, type Pending, portfolioGainKey, servePrecomputed } from "./precompute";
import type { PortfolioScope } from "./scope";

// 24h 盈亏的两条读接口 —— **读 + 传,一次单键读**(ADR 0049 裁定 1)。
// 数字是同步收官那一刻算好的,算它的那台机器(键、水位线、补算、维度)在 ./precompute。

// DeFi 协议行那个数**不是** `Gain`:它按敞口(各腿取绝对值)算分母,没有分段,多一个
// `grossBasis`(见 core/account-view)。**从视图类型上取,不在这里手抄一份** —— 抄的那份迟早
// 跟总览的实现走散,而这两处必须是同一个形状(存进去的就是总览算出来的那个对象)。
export type DefiGain = NonNullable<OverviewView["sections"][number]["defi"][number]["gain24h"]>;

/** 组合级 24h 盈亏的返回形状 —— 存进缓存的和读出去的是同一个,所以它得有个名字。 */
export interface PortfolioGain24h extends Pending {
  portfolio: Gain | null;
  holdings: Record<string, Gain | null>;
  defi: Record<string, DefiGain | null>;
}

/** 账户级 24h 盈亏的返回形状(账户行 + 各余额行)。 */
export interface AccountGain24h extends Pending {
  accounts: Record<string, Gain | null>;
  balances: Record<string, Gain | null>;
}

// 空态 = 「还没算过」。**每次现造一个新对象**:调用方拿到的是响应体,共用一份常量的话,
// 任何一处顺手往上挂个字段都会污染下一次请求。
const emptyPortfolioGain = (): PortfolioGain24h => ({ portfolio: null, holdings: {}, defi: {} });
const emptyAccountGain = (): AccountGain24h => ({ accounts: {}, balances: {} });

/**
 * 组合级 24h 盈亏。
 *
 * `userId` 显式收一次,理由与 `syncAccount` 那条同一个:补算要**另起一次装配**跑在
 * `waitUntil` 上(与这次请求的响应无关的另一个程序),而 `runEffect` 刻意不把 userId
 * 交给 handler。装配点因此走 `runForUser`(见 ./index)。
 */
export const handleGetPortfolioGain24h = Effect.fn("getPortfolioGain24h")(function* (
  userId: string,
  data: PortfolioScope,
) {
  return yield* servePrecomputed(userId, data, portfolioGainKey, emptyPortfolioGain);
});

/** 账户级 24h 盈亏 —— 同上,一次单键读。账户页不吃 pin,所以一个组合一个键。 */
export const handleGetAccountGain24h = Effect.fn("getAccountGain24h")(function* (
  userId: string,
  data: PortfolioScope = {},
) {
  // 账户级只有「默认视图」一个维度 —— 把 pin 丢掉,键里也没有它的位置。
  return yield* servePrecomputed(
    userId,
    { portfolioId: data.portfolioId },
    accountGainKey,
    emptyAccountGain,
  );
});
