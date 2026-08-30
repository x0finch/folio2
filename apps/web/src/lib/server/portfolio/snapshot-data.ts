import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { Effect } from "effect";
import { type PortfolioSnapshotData, toSnapshotView } from "@/lib/core/portfolio";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { type PortfolioScope, type ScopedMaterials, scopedSnapshotMaterials } from "./scope";

// 快照原料读接口(FOL-48 / ADR 0049 的方向调整)—— **发一份「当前快照原料」,浏览器用
// `buildOverview` 自己算**总额 / 持仓 / 各小计 / pricesStale。以前首页读的是同步收官那一刻算好的
// 预计算总览(`servePrecomputed(overviewKey)`);那条读路径退场,换成这条。
//
// **只取行 + 按 scope 在 SQL 里筛 + 备料,不做聚合**(生产实测目标 <10ms CPU):账户集、当下快照、
// 富化字典(名字 / 库里当前价 / 有没有图,logo URL 不下发 —— 见 `TokenView`)、平台元数据、法币
// 身份、估值口径。`liveTotals` /
// `refreshableIds` 是纯函数能从 enriched + 快照算出来的,交给客户端算(见 `overviewFromSnapshotData`)。
//
// 用的是 `buildScopedOverview` 那条装配(`scopedSnapshotMaterials`),**去掉聚合那步** —— 它只备料。

// 场馆键 → 连接器自带的 name + logo(链键返回 null,不进表)。`buildOverview` 会对每个账户的
// connectorId 与每笔持仓的平台键查一次 `connectorMeta`;这里把它会问到的那些键一次备好发下去,
// 客户端据此重建那个查询函数(链键落空 → 走 platformMeta)。
const connectorMetaEntries = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
): [string, { name: string; logo?: string }][] => {
  const keys = new Set<string>();
  for (const account of accounts) {
    keys.add(account.connectorId);
    for (const b of byAccount.get(account.id)?.balances ?? []) {
      keys.add(b.platform ?? account.connectorId);
    }
  }
  const out: [string, { name: string; logo?: string }][] = [];
  for (const key of keys) {
    const meta = connectorPlatformMeta(key);
    if (meta)
      out.push([key, meta.logo ? { name: meta.name, logo: meta.logo } : { name: meta.name }]);
  }
  return out;
};

const toSnapshotData = (m: ScopedMaterials): PortfolioSnapshotData => ({
  accounts: m.accounts,
  snapshots: [...m.byAccount].map(([id, s]) => [id, toSnapshotView(s)] as const),
  // 「24 小时前」那一组(ADR 0050)——浏览器与当前组两端相减算 24h 盈亏。
  prevSnapshots: [...m.prevByAccount].map(([id, s]) => [id, toSnapshotView(s)] as const),
  enriched: [...m.enriched],
  platformMeta: [...m.platformMeta],
  connectorMeta: connectorMetaEntries(m.accounts, m.byAccount),
  fiatRefs: [...m.fiatRefs],
  mode: m.mode,
  now: m.now,
});

export const handleGetPortfolioSnapshotData = Effect.fn("getPortfolioSnapshotData")(function* (
  data: PortfolioScope,
) {
  return toSnapshotData(yield* scopedSnapshotMaterials(data));
});
