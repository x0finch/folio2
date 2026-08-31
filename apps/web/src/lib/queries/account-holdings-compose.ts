import { useSuspenseQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type AccountHoldingsView,
  accountRowsFromRaw,
  assembleAccountHoldingsData,
  floorToHour,
} from "@/lib/core/portfolio";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { tokenEnrichmentQuery } from "@/lib/queries/tokens";
import { accountHoldingsSnapshotQueries } from "./snapshots";

// 账户页持仓:原子资源在浏览器合并(FOL-54 / FOL-55)。key 用 hour-floor 锚;请求 `at` 用墙钟。

export function useAccountHoldingsView(
  portfolioId: string,
  accounts: readonly { id: string; label: string; archivedAt: number | null }[],
): AccountHoldingsView {
  const now = floorToHour(Date.now());
  const { now: snapshotsNowQuery, prev: snapshotsPrevQuery } = accountHoldingsSnapshotQueries(
    portfolioId,
    now,
  );
  const [
    { data: snapshotsNow },
    { data: snapshotsPrev },
    { data: settings },
    { data: enrichment },
  ] = useSuspenseQueries({
    queries: [
      snapshotsNowQuery,
      snapshotsPrevQuery,
      valuationSettingsQuery(),
      tokenEnrichmentQuery(),
    ],
  });
  return useMemo(
    () =>
      accountRowsFromRaw(
        assembleAccountHoldingsData({
          accounts,
          snapshotsNow,
          snapshotsPrev,
          mode: settings.valuationMode,
          enriched: new Map(enrichment.enriched),
        }),
      ),
    [accounts, snapshotsNow, snapshotsPrev, settings.valuationMode, enrichment.enriched],
  );
}
