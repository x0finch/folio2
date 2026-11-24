import type { BalanceKind, Note } from "@folio/connectors-basic";
import { Effect } from "effect";
import { SEMI_PREFIX } from "@/lib/server/creds";
import { EXPORT_VERSION } from "./export";

// Pure import logic (no server-only imports, unit-testable; DB via injected deps). Single pass over NDJSON; the export
// order guarantees id maps exist before records reference them. Merge-style and idempotent: each entity is
// find-or-create by its content natural key (token by ref, account by connectorId+platform+label+creds, snapshot by
// account+takenAt, activity by whole content), so re-importing a file doesn't double and a different file merges.
// Only v3 is accepted (older files report "too old"). Creds: public as-is; semi (masked in export) stored as
// `semi_<key>` placeholders awaiting completion; secrets aren't in the file.

export class ImportError extends Error {}

// Input fields of a connector by exposure level (injected by the route from the registry).
interface InputKinds {
  publicKeys: string[];
  semiKeys: string[];
  secretKeys: string[];
}

interface ImportSnapshotBalance {
  tokenId?: string; // anchor (remapped via tokenMap by apply); required in the DB
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  selfPrice?: number;
  platform?: string;
  meta?: Record<string, unknown>;
  note?: Note; // balance-level note
}

interface ImportActivity {
  kind: "add" | "reduce" | "set";
  amount: number;
  price?: number | null;
  fee?: number | null;
  occurredAt: number;
  memo?: string | null;
  createdAt?: number;
}

// Every import* is find-or-create by its own content natural key, so re-import / merge is idempotent.
export interface ImportDeps {
  categorize(connectorId: string): InputKinds;
  importToken(
    t: {
      symbol: string;
      name: string;
      logo?: string | null;
      providerLogo?: string | null;
      marketCapRank?: number | null;
    },
    refs: { namer: string; localName: string }[],
  ): Effect.Effect<{ id: string }>;
  importAccount(input: {
    connectorId: string;
    platform?: string;
    label: string;
    creds: string;
    archivedAt?: number | null;
  }): Effect.Effect<{ id: string }>;
  importSnapshot(
    accountId: string,
    input: { takenAt: number; totalUsd: number; note?: Note[]; balances: ImportSnapshotBalance[] },
  ): Effect.Effect<void>;
  importManualActivity(
    accountId: string,
    tokenId: string,
    input: ImportActivity,
  ): Effect.Effect<void>;
}

// Write counts per entity; the route returns it as-is, and the settings import reuses it as the return type.
export interface ImportCounts {
  tokens: number;
  accounts: number;
  snapshots: number;
  activities: number;
}

// One NDJSON line -> record; empty / bad JSON -> null (streamed reads yield incomplete lines; callers buffer).
export function parseImportLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asRefs = (v: unknown): { namer: string; localName: string }[] =>
  Array.isArray(v)
    ? v.flatMap((r) =>
        r && typeof r === "object" && typeof r.namer === "string" && typeof r.localName === "string"
          ? [{ namer: r.namer, localName: r.localName }]
          : [],
      )
    : [];

export function createImporter(deps: ImportDeps) {
  const tokenMap = new Map<string, string>(); // exported token id -> new id
  const accountMap = new Map<string, string>();
  const counts: ImportCounts = {
    tokens: 0,
    accounts: 0,
    snapshots: 0,
    activities: 0,
  };
  let metaSeen = false;

  // One record = one effect: the four write ops are in `R` (provided once by the route), so the whole import is one effect with one assembly.
  const apply = (rec: Record<string, unknown>): Effect.Effect<void, ImportError> =>
    Effect.gen(function* () {
      if (rec.type === "meta") {
        const v = rec.version;
        if (v !== EXPORT_VERSION) {
          // Only the current version; older files get a clear "too old" instead of a crash.
          const hint =
            typeof v === "number" && v < EXPORT_VERSION
              ? `export file too old (v${v}); this version only supports v${EXPORT_VERSION}; re-export with a newer version`
              : `unsupported export version: ${String(v)}(expected v${EXPORT_VERSION})`;
          return yield* Effect.fail(new ImportError(hint));
        }
        metaSeen = true;
        return;
      }
      if (!metaSeen) {
        return yield* Effect.fail(
          new ImportError("missing meta header (first line must be type:meta)"),
        );
      }

      switch (rec.type) {
        case "token": {
          const created = yield* deps.importToken(
            {
              symbol: String(rec.symbol ?? ""),
              name: String(rec.name ?? rec.symbol ?? ""),
              logo: typeof rec.logo === "string" ? rec.logo : null,
              providerLogo: typeof rec.providerLogo === "string" ? rec.providerLogo : null,
              marketCapRank: typeof rec.marketCapRank === "number" ? rec.marketCapRank : null,
            },
            asRefs(rec.refs),
          );
          if (typeof rec.id === "string") tokenMap.set(rec.id, created.id);
          counts.tokens++;
          break;
        }
        case "account": {
          const connectorId = String(rec.connectorId);
          const fileCreds = (rec.creds as Record<string, string> | undefined) ?? {};
          const { publicKeys, semiKeys } = deps.categorize(connectorId);
          // Rebuild the stored map: public as-is; semi (masked in export) as `semi_<key>` placeholder; secrets absent from the file.
          const stored: Record<string, string> = {};
          for (const [k, v] of Object.entries(fileCreds)) {
            if (publicKeys.includes(k)) stored[k] = v;
            else if (semiKeys.includes(k)) stored[SEMI_PREFIX + k] = v;
          }
          const created = yield* deps.importAccount({
            connectorId,
            // v3 wire field is `platform` (v2 called it network).
            platform: typeof rec.platform === "string" ? rec.platform : undefined,
            label: String(rec.label ?? ""),
            creds: JSON.stringify(stored),
            // Archived state goes into find-or-create (importAccount aligns an existing match).
            archivedAt: typeof rec.archivedAt === "number" ? rec.archivedAt : undefined,
          });
          if (typeof rec.id === "string") accountMap.set(rec.id, created.id);
          counts.accounts++;
          break;
        }
        case "snapshot": {
          const accountId = accountMap.get(String(rec.accountId));
          if (accountId) {
            const rawBalances = Array.isArray(rec.balances) ? rec.balances : [];
            // The balance's token_id is an export-side id remapped via tokenMap; unmappable rows are dropped (token_id is required
            // and a valid v3 file exports every token first).
            const balances: ImportSnapshotBalance[] = rawBalances.flatMap((b) => {
              const oldId = typeof b.tokenId === "string" ? b.tokenId : undefined;
              const tokenId = oldId ? tokenMap.get(oldId) : undefined;
              if (!tokenId) return [];
              return [{ ...(b as ImportSnapshotBalance), tokenId }];
            });
            yield* deps.importSnapshot(accountId, {
              takenAt: Number(rec.takenAt),
              totalUsd: Number(rec.totalUsd),
              note: Array.isArray(rec.note) ? (rec.note as Note[]) : undefined,
              balances,
            });
            counts.snapshots++;
          }
          break;
        }
        case "manualActivity": {
          const accountId = accountMap.get(String(rec.accountId));
          const tokenId = tokenMap.get(String(rec.tokenId));
          if (accountId && tokenId) {
            yield* deps.importManualActivity(accountId, tokenId, {
              kind: rec.kind as ImportActivity["kind"],
              amount: Number(rec.amount),
              price: typeof rec.price === "number" ? rec.price : null,
              fee: typeof rec.fee === "number" ? rec.fee : null,
              occurredAt: Number(rec.occurredAt),
              memo: typeof rec.memo === "string" ? rec.memo : null,
              createdAt: typeof rec.createdAt === "number" ? rec.createdAt : undefined,
            });
            counts.activities++;
          }
          break;
        }
      }
    });
  return { apply, counts };
}
