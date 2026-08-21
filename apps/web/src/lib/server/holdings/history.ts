import { SnapshotStore } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { runRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";
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
export async function handleGetHoldingHistory({
  data,
  context,
}: {
  data: z.infer<typeof HoldingHistoryInput>;
  context: AuthContext;
}) {
  // 一次 db 读,所以这里的「一次装配」谈不上省了几次边界 —— 它是**为了让门面能被删掉**
  // (#394 T8):`db.` 那层过渡门面每次调用各建一次 layer + 各跑一次 runPromise,方向与
  // 「一次请求一次装配」相反,而它只活到最后一个调用点搬走为止。
  const rows = await runRequest(
    context.userId,
    Effect.flatMap(SnapshotStore, (s) => s.listBalanceHistory(data.since)),
  );
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
}
