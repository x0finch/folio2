import type { Note } from "@folio/connectors-basic";
import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { type BalanceView, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { injectManualPrevSnapshots, injectManualSnapshots } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

// 按组合 + 时间点取每账户快照(ADR 0047 / FOL-54)。**只发原料**:余额行不经 enrich,现价由
// 客户端用 `tokenEnrichment` 合并。manual 账户在 `at` 现算合成项(与 `loadAccountHoldings` 同路)。
export const SnapshotsInput = z.object({
  portfolioId: z.string().optional(),
  at: z.number(),
  after: z.number().optional(),
});

export interface AccountSnapshot {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  note?: Note[];
  balances: BalanceView[];
}

const toBalanceView = (b: {
  id: string;
  amount: number;
  usdValue: number;
  kind: string;
  selfPrice?: number | null;
  platform?: string | null;
  tokenId?: string | null;
  metaJson?: string | null;
}): BalanceView => ({
  id: b.id,
  amount: b.amount,
  usdValue: b.usdValue,
  kind: b.kind,
  selfPrice: b.selfPrice,
  platform: b.platform,
  tokenId: b.tokenId,
  metaJson: b.metaJson ?? null,
});

const toAccountSnapshot = (
  accountId: string,
  snap: {
    snapshot: { takenAt: number; totalUsd: number };
    note?: Note[];
    balances: Parameters<typeof toBalanceView>[0][];
  },
): AccountSnapshot => ({
  accountId,
  takenAt: snap.snapshot.takenAt,
  totalUsd: snap.snapshot.totalUsd,
  note: snap.note,
  balances: snap.balances.map(toBalanceView),
});

export const handleGetSnapshots = Effect.fn("getSnapshots")(function* (
  data: z.infer<typeof SnapshotsInput>,
) {
  const db = yield* Database;
  const member = yield* scopedMembership(data.portfolioId);
  const allAccounts = (yield* db.accounts.list()).filter((a) => member.has(a.id));
  const active = allAccounts.filter((a) => a.archivedAt == null);
  // 当下读(无 after)= 真·每账户最新,不设上界:同步刚落库、`takenAt` 因服务端时钟略超读取方
  // 墙钟的快照不该被 `at` 截掉,而 `collapseSameHour` 已把同小时旧值删掉、没有回退行(e2e sync-round
  // 曾因此把刚同步的账户显示成「从未同步」)。历史读(带 after)才按 [after, at] 窗口 asOf。
  const raw =
    data.after != null
      ? yield* db.snapshots.asOf(data.at, data.after)
      : yield* db.snapshots.latest();
  const memberSet = new Set(allAccounts.map((a) => a.id));
  const byAccount = new Map(
    raw
      .filter((s) => memberSet.has(s.snapshot.accountId))
      .map((s) => [s.snapshot.accountId, s] as const),
  );
  if (data.after != null) {
    // prev 的 `at` 恒为 live 锚 −24h;反推整点锚给手记起点价对齐。
    yield* injectManualPrevSnapshots(active, byAccount, data.at, data.at + GAIN_WINDOW_MS);
  } else {
    // 只喂活跃 manual —— 归档的封存值来自真实快照,不能被现算盖掉(ADR 0039)。
    yield* injectManualSnapshots(active, byAccount, data.at);
  }
  return [...byAccount].map(([accountId, snap]) => toAccountSnapshot(accountId, snap));
});
