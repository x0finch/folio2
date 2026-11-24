import { Note } from "@folio/connectors-basic";
import type { BalanceRawRow, SnapshotRawRow } from "@folio/db";
import type { AccountSnapshotEntry, BalanceView } from "./portfolio";

// Raw D1 rows (positional tuples, unparsed JSON): parsing and validation happen in the browser
// because the Worker only has 10ms CPU per request.
export interface SnapshotsWire {
  snapshots: SnapshotRawRow[];
  balances: BalanceRawRow[];
}

// A corrupt note yields undefined rather than breaking the whole page.
function parseAccountNote(raw: string | null): Note[] | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.array().safeParse(JSON.parse(raw));
    return r.success && r.data.length > 0 ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Preserves the server's snapshot row order. */
export function snapshotsFromWire(wire: SnapshotsWire): AccountSnapshotEntry[] {
  const byAccount = new Map<string, BalanceView[]>();
  for (const [
    accountId,
    id,
    amount,
    usdValue,
    kind,
    selfPrice,
    platform,
    tokenId,
    metaJson,
  ] of wire.balances) {
    const view: BalanceView = {
      id,
      amount,
      usdValue,
      kind,
      selfPrice,
      platform,
      tokenId,
      metaJson,
    };
    const arr = byAccount.get(accountId);
    if (arr) arr.push(view);
    else byAccount.set(accountId, [view]);
  }
  return wire.snapshots.map(([accountId, takenAt, totalUsd, note]) => ({
    accountId,
    takenAt,
    totalUsd,
    note: parseAccountNote(note),
    balances: byAccount.get(accountId) ?? [],
  }));
}
