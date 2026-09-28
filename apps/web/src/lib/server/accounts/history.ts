import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { type AccountHistoryRaw, minMaxDownsampleHistory } from "@/lib/core/history";
import type { HistoryRange } from "@/lib/core/history-range";
import { historyResolution } from "@/lib/core/history-range";
import { MANUAL_CONNECTOR_ID } from "@/lib/core/manual";
import { loadManualAccountLiveTotal, loadManualAccountSeries } from "@/lib/server/manual/store";

function downsampleManualRows(
  rows: readonly { takenAt: number; totalUsd: number }[],
  buckets?: number,
): { takenAt: number; totalUsd: number }[] {
  return minMaxDownsampleHistory(
    rows.map((r) => ({ t: r.takenAt, total: r.totalUsd })),
    buckets,
  ).map((p) => ({ takenAt: p.t, totalUsd: p.total }));
}

export const loadAccountHistory = (input: {
  accountId: string;
  since?: number;
  connectorId?: string;
  range?: HistoryRange;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const resolution = historyResolution({ range: input.range, since: input.since });
    const longWindow = resolution === "sampled";
    if (input.connectorId !== MANUAL_CONNECTOR_ID) {
      // 三档原料同组合曲线(FOL-91):≤ 7 天原始快照,更长读日汇总;1 年 / 全部在 SQL 里按桶封顶
      // (每账户 ≤ 400 点,FOL-92),min-max 降采样在浏览器做。
      const rows =
        resolution === "sampled"
          ? yield* db.snapshots.listSampledTotalsByAccount(input.accountId, input.since)
          : resolution === "daily"
            ? yield* db.snapshots.listDailyTotalsByAccount(input.accountId, input.since)
            : yield* db.snapshots.listTotalsByAccount(input.accountId, input.since);
      return { rows, live: null, sampled: longWindow } satisfies AccountHistoryRaw;
    }
    const account = yield* db.accounts.getById(input.accountId);
    const archivedAt = account?.archivedAt ?? null;
    const now = archivedAt ?? Date.now();
    const series = yield* loadManualAccountSeries(input.accountId, now);
    const clipped = series
      .filter((r) => input.since == null || r.takenAt >= input.since)
      .map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd }));
    const rows = longWindow && clipped.length > 0 ? downsampleManualRows(clipped) : clipped;
    const liveTotal =
      archivedAt != null ? null : yield* loadManualAccountLiveTotal(input.accountId);
    return {
      rows,
      live: liveTotal == null ? null : { t: now, total: liveTotal },
      sampled: longWindow,
    } satisfies AccountHistoryRaw;
  });

export const AccountHistoryInput = z.object({
  accountId: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  connectorId: z.string().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).optional(),
});

export const handleGetAccountHistory = Effect.fn("getAccountHistory")(function* (
  data: z.infer<typeof AccountHistoryInput>,
) {
  return yield* loadAccountHistory(data);
});
