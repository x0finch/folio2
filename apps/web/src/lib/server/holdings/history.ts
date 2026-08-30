import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { shouldSampleHistory } from "@/lib/core/history-range";
import {
  buildTokenValueHistory,
  type TokenValueHistoryRaw,
  type TokenValueHistoryRow,
  tokenHistRowsFromRaw,
} from "@/lib/core/portfolio";
import { minMaxDownsampleHistory } from "@/lib/server/history/minmax";

export const TokenValueHistoryInput = z.object({
  key: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).optional(),
});

// 单币持仓价值历史(FOL-50 + FOL-46):某持仓(按 Holding key = token_id)在窗口内的余额行。
// since 裁窗口 —— 它是 WHERE,是这条接口的上界。**不在服务端聚合身份**(ADR 0021 / #201):
// 身份写快照时就冻进行里了,历史行自己带着 token_id;只取该 token 在窗口内的行。
//
// **短窗**:发原样行,浏览器 `buildTokenValueHistory` 重建 + 自适应降采样。
// **长窗(1y/all)**:与总览/账户曲线一致,服务端就地重建 + min-max 降采样后**发点不发行** ——
// 否则一个持有很久的币会把上千原始行全发下来(payload 随历史膨胀、点太密)。重建复用浏览器那套
// 纯函数(`buildTokenValueHistory`),口径与短窗逐值一致,只是多了一层封顶。
export const handleGetTokenValueHistory = Effect.fn("getTokenValueHistory")(function* (
  data: z.infer<typeof TokenValueHistoryInput>,
) {
  const db = yield* Database;
  const raw = yield* db.snapshots.listBalanceHistoryForToken(data.key, data.since);
  const rows: TokenValueHistoryRow[] = raw.map((r) => ({
    accountId: r.accountId,
    takenAt: r.takenAt,
    amount: r.amount,
    usdValue: r.usdValue,
    kind: r.kind,
    tokenId: r.tokenId,
    metaJson: r.metaJson,
  }));
  if (!shouldSampleHistory({ range: data.range, since: data.since })) {
    return { rows, sampled: false } satisfies TokenValueHistoryRaw;
  }
  const series = buildTokenValueHistory(tokenHistRowsFromRaw(rows), data.key);
  const points = minMaxDownsampleHistory(series.map((p) => ({ t: p.t, total: p.total }))).map(
    (p) => ({ t: p.t, total: p.total }),
  );
  return { rows: [], points, sampled: true } satisfies TokenValueHistoryRaw;
});
