import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { type HistoryRange, type PortfolioHistoryRaw, rangeSince } from "@/lib/core/history";
import { historyResolution } from "@/lib/core/history-range";
import { isManual } from "@/lib/core/manual";
import { loadManualHistoryRows } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

export const PortfolioHistoryInput = z.object({
  portfolioId: z.string().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).default("30d"),
});

export const handleGetPortfolioHistory = Effect.fn("getPortfolioHistory")(function* (data: {
  portfolioId?: string;
  range?: HistoryRange;
}) {
  const range = data.range ?? "30d";
  const since = rangeSince(range, Date.now());
  const resolution = historyResolution({ range });
  const longWindow = resolution === "sampled";
  const db = yield* Database;
  const {
    selectedId,
    defaultId,
    accounts: allAccounts,
    memberships,
  } = yield* scopedMembership(data.portfolioId);
  const memberSet = accountIdsInView(
    allAccounts.map((a) => a.id),
    memberships,
    selectedId,
    defaultId,
  );
  const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
  const snapAccountIds = memberAccounts.filter((a) => !isManual(a.connectorId)).map((a) => a.id);

  const tail = {
    archivedAt: memberAccounts.flatMap((a) =>
      a.archivedAt == null ? [] : [[a.id, a.archivedAt] as [string, number]],
    ),
    liveAccountIds: accountsInView(allAccounts, memberships, selectedId, defaultId).map(
      (a) => a.id,
    ),
  };

  // Manual accounts aren't in the snapshot table: the curve comes from the ledger, not downsampled.
  const manualRows = yield* loadManualHistoryRows(memberAccounts, Date.now(), { since });

  // Raw data per `historyResolution`: <= 7 days raw snapshots, longer windows daily summaries; 1y / all pick
  // extreme-preserving moments per bucket in SQL. Long windows include manual accounts in that SQL so every
  // candidate moment carries all accounts' values; sending manual rows separately would stitch a never-existing total.
  if (longWindow) {
    const rows = yield* db.snapshots.listSampledTotals(
      snapAccountIds,
      since,
      undefined,
      manualRows,
    );
    return { ...tail, rows, sampled: true } satisfies PortfolioHistoryRaw;
  }
  const snapRows =
    resolution === "daily"
      ? yield* db.snapshots.listDailyTotals(snapAccountIds, since)
      : (yield* db.snapshots.listTotals(since)).filter((r) => snapAccountIds.includes(r.accountId));
  const manualIds = new Set(memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
  return {
    ...tail,
    rows: [...snapRows.filter((r) => !manualIds.has(r.accountId)), ...manualRows],
    sampled: false,
  } satisfies PortfolioHistoryRaw;
});
