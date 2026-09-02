import {
  type QueryClient,
  queryOptions,
  useQueryClient,
  useSuspenseQueries,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { accountsMatchingPin, toTabPin } from "@/lib/core/accounts-in-view";
import {
  assemblePortfolioSnapshotData,
  floorToHour,
  isFirstSyncPending,
  overviewConnectorInputs,
  type PortfolioSnapshotData,
  portfolioOverviewFromAtoms,
} from "@/lib/core/portfolio";
import { accountListQuery } from "@/lib/queries/accounts";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { pollWhilePending, STALE_TIME } from "@/lib/queries/constants";
import type { PinScopeKey } from "@/lib/queries/keys";
import { portfolioKeys } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { accountTagLinksQuery } from "@/lib/queries/tags";
import { tokenEnrichmentQuery } from "@/lib/queries/tokens";
import { getFiatRefs, resolvePlatformMeta } from "@/lib/server/portfolio";
import type { AccountSnapshot } from "@/lib/server/portfolio/snapshots";
import { accountHoldingsSnapshotQueries } from "./snapshots";

// 首页总览:原子资源在浏览器合并(FOL-54 / FOL-56)。key 用 hour-floor 锚;当下快照 `at` 用墙钟。

export const fiatRefsQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.fiatRefs(portfolioId),
    queryFn: () => getFiatRefs({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

const platformMetaQuery = (chainIds: readonly string[]) =>
  queryOptions({
    queryKey: portfolioKeys.platformMeta(chainIds),
    queryFn: () => resolvePlatformMeta({ data: { chainIds: [...chainIds] } }),
    staleTime: STALE_TIME.catalogue,
  });

export function usePortfolioOverview(portfolioId: string, pin?: PinScopeKey): PortfolioOverview {
  const queryClient = useQueryClient();
  const now = floorToHour(Date.now());
  const snapshotQueries = accountHoldingsSnapshotQueries(portfolioId, now);

  const [
    { data: accounts },
    { data: tagLinks },
    { data: snapshotsNow },
    { data: snapshotsPrev },
    { data: settings },
    { data: enrichment },
    { data: catalog },
    { data: fiatRefsData },
  ] = useSuspenseQueries({
    queries: [
      accountListQuery(portfolioId),
      accountTagLinksQuery(portfolioId),
      {
        ...snapshotQueries.now,
        refetchInterval: (query: {
          state: { dataUpdateCount: number; data?: AccountSnapshot[] };
        }) => {
          const rows = queryClient.getQueryData(accountListQuery(portfolioId).queryKey);
          if (!rows) return false;
          const active = rows.filter((a) => a.archivedAt == null);
          const mode =
            queryClient.getQueryData(valuationSettingsQuery().queryKey)?.valuationMode ??
            "self-first";
          const pending = isFirstSyncPending(
            {
              accounts: active,
              snapshots: (query.state.data ?? []).map(
                (s: AccountSnapshot) =>
                  [s.accountId, { takenAt: s.takenAt, balances: s.balances }] as const,
              ),
              prevSnapshots: [],
              enriched: [],
              platformMeta: [],
              connectorMeta: [],
              fiatRefs: [],
              mode,
              now,
            },
            // 真墙钟,不是 floored 锚点 `now` —— 否则首次同步窗被撑大最多 ~1 小时,轮询会多空转。
            Date.now(),
          );
          return pollWhilePending(query, pending);
        },
      },
      snapshotQueries.prev,
      valuationSettingsQuery(),
      tokenEnrichmentQuery(),
      connectorCatalogQuery(),
      fiatRefsQuery(portfolioId),
    ],
  });

  const scopedAccounts = useMemo(() => {
    const active = accounts.filter((a) => a.archivedAt == null);
    const tabPin = toTabPin(pin);
    return tabPin ? accountsMatchingPin(active, tabPin, tagLinks) : active;
  }, [accounts, pin, tagLinks]);

  const scopedSnapshotsNow = useMemo(
    () => snapshotsNow.filter((s) => scopedAccounts.some((a) => a.id === s.accountId)),
    [snapshotsNow, scopedAccounts],
  );
  const scopedSnapshotsPrev = useMemo(
    () => snapshotsPrev.filter((s) => scopedAccounts.some((a) => a.id === s.accountId)),
    [snapshotsPrev, scopedAccounts],
  );

  const { connectorMeta, chainIds } = useMemo(
    () => overviewConnectorInputs(scopedAccounts, scopedSnapshotsNow, catalog),
    [scopedAccounts, scopedSnapshotsNow, catalog],
  );

  const { data: platformMetaData } = useSuspenseQuery(platformMetaQuery(chainIds));

  return useMemo(
    () =>
      portfolioOverviewFromAtoms(
        {
          accounts: scopedAccounts,
          snapshotsNow: scopedSnapshotsNow,
          snapshotsPrev: scopedSnapshotsPrev,
          enriched: new Map(enrichment.enriched),
          mode: settings.valuationMode,
          platformMeta: platformMetaData.platformMeta,
          connectorMeta,
          fiatRefs: fiatRefsData.fiatRefs,
          now,
        },
        // pending 判定用真墙钟;`now`(floored 锚点)只喂快照 key。每次 memo 重算取新的 Date.now(),
        // 阈值就不会被 hour-floor 低估最多 ~1 小时(见 isFirstSyncPending)。
        Date.now(),
      ),
    [
      scopedAccounts,
      scopedSnapshotsNow,
      scopedSnapshotsPrev,
      enrichment.enriched,
      settings.valuationMode,
      platformMetaData.platformMeta,
      connectorMeta,
      fiatRefsData.fiatRefs,
      now,
    ],
  );
}

/** 未收窄 pin 的快照原料 —— 首页 tab 条 `computeHomeTabStrip` 用。 */
export function usePortfolioSnapshotAtoms(portfolioId: string) {
  const now = floorToHour(Date.now());
  const snapshotQueries = accountHoldingsSnapshotQueries(portfolioId, now);

  const [
    { data: accounts },
    { data: snapshotsNow },
    { data: snapshotsPrev },
    { data: settings },
    { data: enrichment },
    { data: catalog },
    { data: fiatRefsData },
  ] = useSuspenseQueries({
    queries: [
      accountListQuery(portfolioId),
      snapshotQueries.now,
      snapshotQueries.prev,
      valuationSettingsQuery(),
      tokenEnrichmentQuery(),
      connectorCatalogQuery(),
      fiatRefsQuery(portfolioId),
    ],
  });

  const activeAccounts = useMemo(() => accounts.filter((a) => a.archivedAt == null), [accounts]);

  const { connectorMeta, chainIds } = useMemo(
    () => overviewConnectorInputs(activeAccounts, snapshotsNow, catalog),
    [activeAccounts, snapshotsNow, catalog],
  );

  const { data: platformMetaData } = useSuspenseQuery(platformMetaQuery(chainIds));

  return useMemo(
    () =>
      assemblePortfolioSnapshotData({
        accounts: activeAccounts,
        snapshotsNow,
        snapshotsPrev,
        enriched: new Map(enrichment.enriched),
        mode: settings.valuationMode,
        platformMeta: platformMetaData.platformMeta,
        connectorMeta,
        fiatRefs: fiatRefsData.fiatRefs,
        now,
      }),
    [
      activeAccounts,
      snapshotsNow,
      snapshotsPrev,
      enrichment.enriched,
      settings.valuationMode,
      platformMetaData.platformMeta,
      connectorMeta,
      fiatRefsData.fiatRefs,
      now,
    ],
  );
}

/** 非 hook 路径:从 query 缓存拉原子资源并组装快照原料(pin 写后刷新 tab 条用)。 */
export async function fetchPortfolioSnapshotAtoms(
  queryClient: QueryClient,
  portfolioId: string,
): Promise<PortfolioSnapshotData> {
  const now = floorToHour(Date.now());
  const snapshotQueries = accountHoldingsSnapshotQueries(portfolioId, now);
  const [accounts, snapshotsNow, snapshotsPrev, settings, enrichment, catalog, fiatRefsData] =
    await Promise.all([
      queryClient.fetchQuery(accountListQuery(portfolioId)),
      queryClient.fetchQuery(snapshotQueries.now),
      queryClient.fetchQuery(snapshotQueries.prev),
      queryClient.fetchQuery(valuationSettingsQuery()),
      queryClient.fetchQuery(tokenEnrichmentQuery()),
      queryClient.fetchQuery(connectorCatalogQuery()),
      queryClient.fetchQuery(fiatRefsQuery(portfolioId)),
    ]);
  const activeAccounts = accounts.filter((a) => a.archivedAt == null);
  const { connectorMeta, chainIds } = overviewConnectorInputs(
    activeAccounts,
    snapshotsNow,
    catalog,
  );
  const platformMetaData = await queryClient.fetchQuery(platformMetaQuery(chainIds));
  return assemblePortfolioSnapshotData({
    accounts: activeAccounts,
    snapshotsNow,
    snapshotsPrev,
    enriched: new Map(enrichment.enriched),
    mode: settings.valuationMode,
    platformMeta: platformMetaData.platformMeta,
    connectorMeta,
    fiatRefs: fiatRefsData.fiatRefs,
    now,
  });
}
