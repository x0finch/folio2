import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { historyResolution } from "@/lib/core/history-range";
import type { TokenValueHistoryRaw } from "@/lib/core/portfolio";

export const TokenValueHistoryInput = z.object({
  key: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).optional(),
});

// 单币持仓价值历史(FOL-50 + FOL-46):某持仓(按 Holding key = token_id)在窗口内每账户的现货价值。
// since 裁窗口 —— 它是 WHERE,是这条接口的上界。**不在服务端聚合身份**(ADR 0021 / #201):
// 身份写快照时就冻进行里了,历史行自己带着 token_id。
//
// **合计与封顶在 SQL 里做,重建与降采样在浏览器做**(FOL-92)。以前短窗发的是窗口内每一条余额行
// (带 meta_json)、长窗在服务端 JS 里重建 + min-max —— 两头都是 Worker 按行付 CPU。现在 D1 直接给
// 「每账户每桶一个合计」,行数有上界(≤ 7 天每张快照一行 / 30 天每天一行 / 1 年·全部每账户 ≤ 200 行),
// 浏览器按组合曲线那套阶梯重建(`tokenValueHistoryFromRaw`)。
export const handleGetTokenValueHistory = Effect.fn("getTokenValueHistory")(function* (
  data: z.infer<typeof TokenValueHistoryInput>,
) {
  const db = yield* Database;
  const resolution = historyResolution({ range: data.range, since: data.since });
  const rows = yield* db.snapshots.listTokenValueTotals(
    data.key,
    data.since,
    resolution === "hourly" ? "snapshot" : resolution === "daily" ? "day" : "sampled",
  );
  return { rows, sampled: resolution === "sampled" } satisfies TokenValueHistoryRaw;
});
