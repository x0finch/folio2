import { Database, type SnapshotWithBalances } from "@folio/db";
import { Effect } from "effect";
import { connectorLabelFallback, platformLogoUrl } from "@/lib/core/logo";
import type { PortfolioRosterData, RosterSnapshotView } from "@/lib/core/portfolio";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { type PortfolioSelect, resolveScope } from "./scope";

// 名单原料读接口(FOL-49)—— 发账户 / 归属 / 标签 / pin / 最新快照(kind+meta) / connector 展示元数据,
// 浏览器用 `computeHomeTabStrip` 自己算 tab 条。**只取行 + 备料,不做聚合**。

const toRosterSnapshot = (s: SnapshotWithBalances): RosterSnapshotView => ({
  balances: s.balances.map((b) => ({
    id: b.id,
    amount: b.amount,
    usdValue: b.usdValue,
    kind: b.kind,
    metaJson: b.metaJson,
  })),
});

const connectorMetaEntries = (
  pins: readonly { kind: string; connectorId: string | null }[],
): [string, { name: string; logo?: string }][] => {
  const keys = new Set<string>();
  for (const p of pins) {
    if (p.kind === "connector" && p.connectorId) keys.add(p.connectorId);
  }
  const out: [string, { name: string; logo?: string }][] = [];
  for (const key of keys) {
    const meta = connectorPlatformMeta(key);
    const logo = platformLogoUrl(key, meta?.logo);
    out.push([
      key,
      logo
        ? { name: meta?.name ?? connectorLabelFallback(key), logo }
        : { name: meta?.name ?? connectorLabelFallback(key) },
    ]);
  }
  return out;
};

export const handleGetPortfolioRoster = Effect.fn("getPortfolioRoster")(function* (
  data: PortfolioSelect,
) {
  const db = yield* Database;
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [allAccounts, snapshots, memberships, pins, tags] = yield* Effect.all(
    [
      db.accounts.list(),
      db.snapshots.latest(),
      db.portfolios.listMemberships(),
      db.tabPins.list(),
      db.tags.list(),
    ],
    { concurrency: 5 },
  );

  return {
    selectedPortfolioId: selectedId,
    defaultPortfolioId: defaultId,
    accounts: allAccounts,
    memberships,
    pins,
    tags,
    snapshots: snapshots.map((s) => [s.snapshot.accountId, toRosterSnapshot(s)] as const),
    connectorMeta: connectorMetaEntries(pins),
  } satisfies PortfolioRosterData;
});
