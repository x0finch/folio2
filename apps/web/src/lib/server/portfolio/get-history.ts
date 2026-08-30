import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import {
  type HistoryRange,
  isLongHistoryRange,
  type PortfolioHistoryRaw,
  rangeSince,
} from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import { loadManualHistoryRows } from "@/lib/server/manual/store";
import { resolveScope } from "./scope";

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
  const longWindow = isLongHistoryRange(range);
  const db = yield* Database;
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [allAccounts, memberships] = yield* Effect.all(
    [db.accounts.list(), db.portfolios.listMemberships()],
    { concurrency: 2 },
  );
  const memberSet = accountIdsInView(
    allAccounts.map((a) => a.id),
    memberships,
    selectedId,
    defaultId,
  );
  const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
  const snapAccountIds = memberAccounts.filter((a) => !isManual(a.connectorId)).map((a) => a.id);

  const snapRows = longWindow
    ? yield* db.snapshots.listTotalsMinMax(snapAccountIds, since)
    : (yield* db.snapshots.listTotals(since)).filter((r) => snapAccountIds.includes(r.accountId));

  const manualIds = new Set(memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
  const manualRows = yield* loadManualHistoryRows(memberAccounts, Date.now(), {
    since,
    sampled: longWindow,
  });
  const archivedAt = memberAccounts.flatMap((a) =>
    a.archivedAt == null ? [] : [[a.id, a.archivedAt] as [string, number]],
  );
  const liveAccountIds = accountsInView(allAccounts, memberships, selectedId, defaultId).map(
    (a) => a.id,
  );
  return {
    rows: [...snapRows.filter((r) => !manualIds.has(r.accountId)), ...manualRows],
    archivedAt,
    liveAccountIds,
    sampled: longWindow,
  } satisfies PortfolioHistoryRaw;
});
