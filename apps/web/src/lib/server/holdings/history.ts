import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { buildTokenValueHistory, type TokenHistRow } from "./token-history";

export const HoldingHistoryInput = z.object({
  key: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
});

// 单币持仓价值历史(H6 片2):某持仓(按 Holding key = token_id)的价值随时间。
// 全历史余额 → 按 eligibility 过滤(与 overview-model 同口径:**只认现货**,perp 权益不进 —— #129)
// → buildTokenValueHistory 归属 + 跨账户阶梯重建。过去点用冻结 usd_value(不现推);since 裁窗口。
//
// **不再富化**(ADR 0021 / #201):身份在写快照时就冻进行里了,历史行自己带着 token_id。
// 以前这里要把几千条历史行整批 enrich 一遍才知道它们是哪个币 —— 那一趟 D1 往返整个消失。
export const handleGetHoldingHistory = Effect.fn("getHoldingHistory")(function* (
  data: z.infer<typeof HoldingHistoryInput>,
) {
  const rows = yield* (yield* Database).snapshots.listBalanceHistory(data.since);
  // eligibility 与 overview-model 同口径:**只认现货**(perp 权益不进聚合 → 也不进单币历史,#129)。
  const eligible = rows.filter((r) => isFungible(viewKind(r)));
  const histRows: TokenHistRow[] = eligible.map((r) => ({
    // 历史只按 token_id 归属、求和冻结 value(groupKey 恒命中 tokenId 分支),不显示 symbol
    // → 不再从快照取(#243 删了该列)。
    symbol: "",
    amount: r.amount,
    value: r.usdValue, // 冻结口径(过去点用当时快照值,不现推)
    kind: viewKind(r),
    account: { id: r.accountId, label: "", connectorId: "" }, // groupKey 只用 account.id
    tokenId: r.tokenId,
    takenAt: r.takenAt,
  }));
  return { series: buildTokenValueHistory(histRows, data.key) };
});
