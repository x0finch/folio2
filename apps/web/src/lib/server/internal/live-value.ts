import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { TokenService } from "@folio/oracle";
import { type ValuationMode, valuate } from "@folio/oracle-basic";
import { Effect } from "effect";
import type { OverviewBalance } from "../../core/account-view";
import { fungibleTokenId } from "./tokens";

// 读时现推(Phase 3,#81):不落库,按当前 mode + 实时源价重算 value。
// 关键:存储的 `selfPrice` 已编码盯市决策 —— null = 盯市类型(manual/bitcoin,无权威自带价,恒用源);
// 数值 = enrich-not-reprice(CEX/链上/perp,自带价 = 同步时 value/amount)。故读时无需 connectorId,
// 纯 valuate(amount, selfPrice, 源价, mode)。源价缺(未解析/未预热)或都无 → 兜底冻结 usdValue。
export interface RevaluableBalance {
  amount: number;
  usdValue: number;
  selfPrice?: number | null;
}

export function liveValue(
  b: RevaluableBalance,
  sourcePrice: number | undefined,
  mode: ValuationMode,
): number {
  const v = valuate(b.amount, b.selfPrice ?? undefined, sourcePrice, mode);
  return v?.value ?? b.usdValue;
}

// 按账户现推净值:对每账户最新快照的**全部**余额取 cache-only 源价(一次批量 enrich),liveValue 求和。
// 代币能力不再当参数传,而是 `R` 通道上的 `TokenService` —— 调用方(server fn)一次 `runRequest` 全供上。
// self-first(默认)下 enrich-not-reprice 行 value≡冻结、盯市行取实时源价 → 与主页总价同源同算。
// 主页(buildOverview)与资产曲线当下点(history)共用本函数,保证「主页总价 ≡ 曲线当下点」。
export const deriveLiveAccountTotals = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  mode: ValuationMode,
): Effect.Effect<Map<string, number>, never, TokenService> =>
  Effect.gen(function* () {
    const balancesOf = (id: string) => (byAccount.get(id)?.balances ?? []) as OverviewBalance[];
    // 一次性摊平 + 按 token_id 批量读价(cache-only,零网络);非同质行没有 id → 源价 undefined。
    // 以前这里靠「enrich 同序返回 + i++ 走下标」配对,是个 locality 隐患;按 id 查表之后不存在了。
    const flat = accounts.flatMap((a) => balancesOf(a.id));
    const ids = [
      ...new Set(flat.flatMap((b) => (fungibleTokenId(b) ? [fungibleTokenId(b) as string] : []))),
    ];
    const enriched = yield* Effect.flatMap(TokenService, (t) => t.enrich(ids));
    const priceOf = (b: OverviewBalance): number | undefined => {
      const id = fungibleTokenId(b);
      return id ? enriched.get(id)?.price?.unitPrice : undefined;
    };

    const totals = new Map<string, number>();
    for (const account of accounts) {
      let total = 0;
      for (const b of balancesOf(account.id)) total += liveValue(b, priceOf(b), mode);
      totals.set(account.id, total);
    }
    return totals;
  });
