import {
  type BalanceRawRow,
  Database,
  type SnapshotRawRow,
  type SnapshotWithBalances,
} from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import type { SnapshotsWire } from "@/lib/core/snapshot-wire";
import { injectManualPrevSnapshots, injectManualSnapshots } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

// 按组合 + 时间点取每账户快照(ADR 0047 / FOL-54)。**只发原料**:余额行不经 enrich,现价由
// 客户端用 `tokenEnrichment` 合并。manual 账户在 `at` 现算合成项(与 `loadAccountHoldings` 同路)。
//
// **原料是 D1 回来的原样行**(FOL-92):位置元组、note / meta 不解析 —— 解析、校验、拼成
// `AccountSnapshotEntry` 在浏览器做(`@/lib/core/snapshot-wire`)。服务端这里没有逐行的活,
// 只剩按组合筛一遍(一次 Set 查询)。
export const SnapshotsInput = z.object({
  portfolioId: z.string().optional(),
  at: z.number(),
  after: z.number().optional(),
});

// manual 合成的那几张(每账户至多一张、几行)→ 与库里同形的元组。
const manualToWire = (byAccount: ReadonlyMap<string, SnapshotWithBalances>): SnapshotsWire => {
  const snapshots: SnapshotRawRow[] = [];
  const balances: BalanceRawRow[] = [];
  for (const [accountId, s] of byAccount) {
    snapshots.push([accountId, s.snapshot.takenAt, s.snapshot.totalUsd, s.snapshot.note]);
    for (const b of s.balances) {
      balances.push([
        accountId,
        b.id,
        b.amount,
        b.usdValue,
        b.kind,
        b.selfPrice ?? null,
        b.platform ?? null,
        b.tokenId ?? null,
        b.metaJson ?? null,
      ]);
    }
  }
  return { snapshots, balances };
};

export const handleGetSnapshots = Effect.fn("getSnapshots")(function* (
  data: z.infer<typeof SnapshotsInput>,
) {
  const db = yield* Database;
  // 当下读(无 after)= 真·每账户最新,不设上界:同步刚落库、`takenAt` 因服务端时钟略超读取方
  // 墙钟的快照不该被 `at` 截掉,而 `collapseSameHour` 已把同小时旧值删掉、没有回退行(e2e sync-round
  // 曾因此把刚同步的账户显示成「从未同步」)。历史读(带 after)才按 [after, at] 窗口 asOf。
  const [scope, raw] = yield* Effect.all(
    [
      scopedMembership(data.portfolioId),
      data.after != null ? db.snapshots.asOfRaw(data.at, data.after) : db.snapshots.latestRaw(),
    ],
    { concurrency: 2 },
  );
  const active = scope.accounts.filter((a) => scope.has(a.id) && a.archivedAt == null);

  const manual = new Map<string, SnapshotWithBalances>();
  if (data.after != null) {
    // prev 的 `at` 恒为 live 锚 −24h;反推整点锚给手记起点价对齐。
    yield* injectManualPrevSnapshots(active, manual, data.at, data.at + GAIN_WINDOW_MS);
  } else {
    // 只喂活跃 manual —— 归档的封存值来自真实快照,不能被现算盖掉(ADR 0039)。
    yield* injectManualSnapshots(active, manual, data.at);
  }
  // 现算的那张胜过库里的(与以前 `byAccount.set` 覆盖同一个口径)。
  const keep = (accountId: string) => scope.has(accountId) && !manual.has(accountId);
  const synced: SnapshotsWire = {
    snapshots: raw.snapshots.filter((r) => keep(r[0])),
    balances: raw.balances.filter((r) => keep(r[0])),
  };
  if (manual.size === 0) return synced;
  const injected = manualToWire(manual);
  return {
    snapshots: [...synced.snapshots, ...injected.snapshots],
    balances: [...synced.balances, ...injected.balances],
  } satisfies SnapshotsWire;
});
