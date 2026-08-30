import type { Note } from "@folio/connectors-basic";
import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import type { BalanceView } from "@/lib/core/portfolio";
import { injectManualPrevSnapshots, injectManualSnapshots } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

// 按组合 + 时间点取每账户快照(ADR 0047 / FOL-54)。**只发原料**:余额行不经 enrich,现价由
// 客户端用 `tokenEnrichment` 合并。manual 账户在 `at` 现算合成项(与 `loadAccountHoldings` 同路)。
export const SnapshotsInput = z.object({
  portfolioId: z.string().optional(),
  at: z.number(),
  after: z.number().optional(),
  now: z.number().optional(),
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
  const upTo = data.after != null ? data.at : (data.now ?? data.at);
  const raw = yield* db.snapshots.asOf(upTo, data.after ?? 0);
  const memberSet = new Set(allAccounts.map((a) => a.id));
  const byAccount = new Map(
    raw
      .filter((s) => memberSet.has(s.snapshot.accountId))
      .map((s) => [s.snapshot.accountId, s] as const),
  );
  const referenceNow = data.now ?? data.at;
  if (data.after != null) {
    yield* injectManualPrevSnapshots(active, byAccount, data.at, referenceNow);
  } else {
    // 只喂活跃 manual —— 归档的封存值来自真实快照,不能被现算盖掉(ADR 0039)。
    yield* injectManualSnapshots(active, byAccount, upTo);
  }
  return [...byAccount].map(([accountId, snap]) => toAccountSnapshot(accountId, snap));
});
