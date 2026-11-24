// Pure (no server-only imports, unit-testable): maps entities to export NDJSON records, one JSON per line.
// An account's safeCreds are computed by creds.ts `safeView` in the route and passed in (secret dropped, semi masked, public kept).

// v3: older files aren't accepted. Identity is token_id only, so the file carries Token rows (ref embedded) and the
// manual ledger. Stream order: meta, token, account, snapshot, activity (the single-pass import maps old to new ids).
export const EXPORT_VERSION = 3;

interface TokenIn {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  providerLogo: string | null;
  marketCapRank: number | null;
  refs: { namer: string; localName: string }[];
}
interface AccountIn {
  id: string;
  connectorId: string;
  platform: string | null;
  label: string;
  archivedAt: number | null;
}
interface SnapshotIn {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  note: string | null; // JSON of the account-level Note[]
}
interface BalanceIn {
  tokenId: string | null; // identity anchor; always set in practice
  amount: number;
  usdValue: number;
  kind: string;
  selfPrice: number | null; // valuation input, exported with the row
  platform: string | null;
  metaJson: string | null; // typed meta (perp coin etc.)
  note: string | null; // JSON of the balance-level Note
}
interface ActivityIn {
  accountId: string;
  tokenId: string | null;
  kind: string;
  amount: number;
  price: number | null;
  fee: number | null;
  occurredAt: number;
  memo: string | null;
  createdAt: number; // same-occurredAt fold order depends on it (deriveAmount)
}

function safeParse(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// First line: version info for the import's version gate.
export function metaRecord(exportedAt: number) {
  return { type: "meta" as const, version: EXPORT_VERSION, app: "folio" as const, exportedAt };
}

// Token record: ref embedded like in snapshot balances. Price facet / self_price are not exported (see db `listTokensForExport`).
export function tokenRecord(t: TokenIn) {
  return {
    type: "token" as const,
    id: t.id,
    symbol: t.symbol,
    name: t.name,
    logo: t.logo ?? undefined,
    providerLogo: t.providerLogo ?? undefined,
    marketCapRank: t.marketCapRank ?? undefined,
    refs: t.refs,
  };
}

// safeCreds must already be redacted by the route (public as-is, semi masked, no secret). Manual holdings live in
// token + activity records, not creds. `archivedAt` is exported so archived accounts stay archived on import.
export function accountRecord(account: AccountIn, safeCreds: Record<string, string>) {
  return {
    type: "account" as const,
    id: account.id,
    connectorId: account.connectorId,
    // `platform` matches the db column name.
    platform: account.platform ?? undefined,
    label: account.label,
    archivedAt: account.archivedAt ?? undefined, // set means archived; import re-archives
    creds: safeCreds,
  };
}

export function snapshotRecord(s: SnapshotIn, balances: BalanceIn[]) {
  return {
    type: "snapshot" as const,
    accountId: s.accountId,
    takenAt: s.takenAt,
    totalUsd: s.totalUsd,
    note: safeParse(s.note),
    balances: balances.map((b) => ({
      tokenId: b.tokenId ?? undefined,
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind,
      selfPrice: b.selfPrice ?? undefined,
      platform: b.platform ?? undefined,
      meta: safeParse(b.metaJson),
      note: safeParse(b.note),
    })),
  };
}

// Flat record; accountId / tokenId are export-side ids that import remaps. The `manual` prefix is because it holds only `manual_activity`.
export function manualActivityRecord(a: ActivityIn) {
  return {
    type: "manualActivity" as const,
    accountId: a.accountId,
    tokenId: a.tokenId ?? undefined,
    kind: a.kind,
    amount: a.amount,
    price: a.price ?? undefined,
    fee: a.fee ?? undefined,
    occurredAt: a.occurredAt,
    memo: a.memo ?? undefined,
    createdAt: a.createdAt,
  };
}

// One record -> one NDJSON line (with newline).
export function ndjsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
