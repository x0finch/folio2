import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import type { TokenValueHistoryRaw } from "@/lib/core/portfolio";

export const TokenValueHistoryInput = z.object({
  key: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
});

// 单币持仓价值历史(FOL-50):某持仓(按 Holding key = token_id)在窗口内的原样余额行。
// 阶梯重建在浏览器里(buildTokenValueHistory);since 裁窗口 —— 它是 WHERE,是这条接口的上界。
//
// **不再在服务端聚合**(ADR 0021 / #201):身份在写快照时就冻进行里了,历史行自己带着 token_id。
// 只取该 token 在窗口内的行,比扫全历史再筛省一大截。
export const handleGetTokenValueHistory = Effect.fn("getTokenValueHistory")(function* (
  data: z.infer<typeof TokenValueHistoryInput>,
) {
  const db = yield* Database;
  const rows = yield* db.snapshots.listBalanceHistoryForToken(data.key, data.since);
  return {
    rows: rows.map((r) => ({
      accountId: r.accountId,
      takenAt: r.takenAt,
      amount: r.amount,
      usdValue: r.usdValue,
      kind: r.kind,
      tokenId: r.tokenId,
      metaJson: r.metaJson,
    })),
  } satisfies TokenValueHistoryRaw;
});
