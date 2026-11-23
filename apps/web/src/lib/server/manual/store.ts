import {
  type AccountSafe,
  Database,
  type DbRequest,
  type ManualActivity,
  type ManualActivityPatch,
  type ManualHolding,
  type NotFound,
  type SnapshotWithBalances,
} from "@folio/db";
import { Oracle } from "@folio/oracle";
import { dayBucketOf, FIAT_NAMER, fiatCodeOf, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect } from "effect";
import type { SnapshotTotalRow } from "@/lib/core/history";
import type { CredsToken } from "@/lib/core/manual";
import {
  buildManualAccountSeries,
  deriveAmount,
  fallbackUnitPrice,
  type HistoricalPriceAt,
  type HistoryToken,
  isManual,
  MANUAL_CONNECTOR_ID,
  projectToken,
  tokenPriceAt,
  tokenQuantityAt,
} from "@/lib/core/manual";
import type { BalanceLike } from "@/lib/core/token-model";
import { NAMER } from "@/lib/server/oracle";
import { type BatchDraft, planManualBatch, runningOk, type Token } from "./batch";
import { buildManualSnapshot, manualUnitPrices } from "./snapshot";

const AMOUNT_EPS = 1e-9;

// Holdings are always computed on read from the ledger; nothing is materialised back into creds.

// Server-side on purpose: keeps the tokenRef grammar out of the client bundle.
// A picked token's ref is authoritative for mint. Unpicked → `manual/custom:<name>`, which mint
// never matches against known tokens: the user typed it precisely because it wasn't listed.
const manualTokenRef = (picked: { symbol: string; ref?: string | null }): string =>
  picked.ref || tokenRef.custom(MANUAL_CONNECTOR_ID, picked.symbol);

// Tickets are unsigned, so only accept namers we issue; a forged `<x>/issued:<y>` would otherwise
// make the user-typed symbol a trusted identity hint again. Anything else falls back to custom.
const mintHolding = (picked: {
  symbol: string;
  ticket?: string | null;
}): Effect.Effect<string, never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const ref = manualTokenRef({
      symbol: picked.symbol,
      // Crypto tickets use the current upstream namer, fiat ones `fiat`; other namers are rejected.
      ref: picked.ticket ? tokenTicket.decode(picked.ticket, [NAMER, FIAT_NAMER]) : undefined,
    });
    const symbol = picked.symbol.trim().toUpperCase();
    const ids = yield* Effect.flatMap(Oracle, (o) => o.tokens.mint([{ ref, seed: { symbol } }]));
    const id = ids.get(ref);
    if (!id) throw new Error(`mint produced no token for ${ref}`);
    return id;
  });

// The form submits the first token as single-element JSON, already validated by `validate`.
export const createManualAccount = (
  label: string,
  tokens: string,
): Effect.Effect<AccountSafe, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const [first] = JSON.parse(tokens) as Array<{
      symbol: string;
      unitPrice: number | string;
      ticket?: string;
      amount: number | string;
    }>;
    // The schema allows an empty array; the form always sends one.
    if (!first) throw new Error("manual account requires at least one token");
    const db = yield* Database;
    const account = yield* db.accounts.create({
      connectorId: MANUAL_CONNECTOR_ID,
      label,
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const tokenId = yield* mintHolding(first);
    yield* db.manual.setHoldingDef(tokenId, { symbol: first.symbol.trim().toUpperCase() });
    // The opening price goes into the ledger, not a token column: the ledger is the only price
    // source, so a bad value can't stick.
    yield* db.manual.recordActivity(account.id, tokenId, {
      kind: "set",
      amount: Number(first.amount),
      price: Number(first.unitPrice) > 0 ? Number(first.unitPrice) : null,
      occurredAt: Date.now(),
    });
    return account;
  });

// Active manual accounts' tokens, amounts derived from the ledger on read. Archived accounts are
// excluded, matching enrichment, warming and price refresh.
const manualTokensByAccount = (
  accounts: AccountSafe[],
): Effect.Effect<{ id: string; tokens: CredsToken[] }[], NotFound, Database | DbRequest> => {
  const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
  if (manual.length === 0) return Effect.succeed([]);
  return Effect.forEach(
    manual,
    (a) =>
      Effect.map(loadTokensWithActivities(a.id), (rows) => ({
        id: a.id,
        tokens: rows.map(({ token, activities }) => projectToken(token, activities)),
      })),
    { concurrency: "unbounded" },
  );
};

// tokenId → `fiat/issued:<CODE>`. `TokenRecord.ref` is the upstream (CoinGecko) ref and is null for
// fiat, so identity is looked up under FIAT_NAMER.
export const manualFiatRefs = (
  accounts: AccountSafe[],
): Effect.Effect<Map<string, string>, NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
    const out = new Map<string, string>();
    const perAccount = yield* Effect.forEach(manual, (a) => store.listHoldings(a.id, FIAT_NAMER), {
      concurrency: "unbounded",
    });
    for (const holdings of perAccount) {
      for (const h of holdings) if (h.ref) out.set(h.id, h.ref);
    }
    return out;
  });

// Injects synthesised current snapshots for manual accounts into `byAccount`. Prices come from the
// cache-only enrichment; on a cold cache (or unrecognised custom tokens) they fall back to the
// user's price. Fiat is identified via `fiatRefs` and priced at the live fx rate.
export const injectManualSnapshots = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  takenAt: number = Date.now(),
): Effect.Effect<void, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const list = yield* manualTokensByAccount(accounts);
    if (list.length === 0) return;
    const fiatRefs = yield* manualFiatRefs(accounts);
    const enriched = yield* Effect.flatMap(Oracle, (o) =>
      o.tokens.enrich(list.flatMap(({ tokens }) => tokens.map((tk) => tk.id))),
    );
    yield* Effect.forEach(list, ({ id, tokens }) =>
      Effect.map(manualUnitPrices(tokens, enriched, fiatRefs), (prices) => {
        byAccount.set(id, buildManualSnapshot(id, tokens, prices, takenAt));
      }),
    );
  });

// Sealing on archive: manual accounts never write snapshots, so write one real snapshot from the
// ledger, reusing the injection path so there is one answer for "what is it worth now".
// The account must not be flagged archived yet — injection skips archived accounts.
// Returns whether a snapshot was written (non-manual accounts already have snapshots).
export const sealManualAccount = (
  account: AccountSafe,
  takenAt: number = Date.now(),
): Effect.Effect<boolean, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    if (!isManual(account.connectorId)) return false;
    const byAccount = new Map<string, SnapshotWithBalances>();
    yield* injectManualSnapshots([account], byAccount, takenAt);
    const built = byAccount.get(account.id);
    // No holdings: an empty snapshot would look like "never synced" yet add a row of history.
    if (!built) return false;
    yield* Effect.flatMap(Database, (db) =>
      db.snapshots.write(account.id, {
        takenAt,
        totalUsd: built.snapshot.totalUsd,
        balances: built.balances.map((b) => ({
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          platform: b.platform ?? undefined,
          tokenId: b.tokenId ?? undefined,
        })),
      }),
    );
    return true;
  });

// Manual tokens for price warming: they never appear in snapshots, so warming from snapshots alone
// would miss them.
export const manualBalancesForWarm = (
  accounts: AccountSafe[],
): Effect.Effect<BalanceLike[], NotFound, Database | DbRequest> =>
  Effect.map(manualTokensByAccount(accounts), (list) =>
    list.flatMap(({ id, tokens }) => buildManualSnapshot(id, tokens, [], 0).balances),
  );

export interface CreateTokenInput {
  accountId: string;
  symbol: string;
  unitPrice: number;
  ticket?: string | null;
  amount: number;
}
export interface UpdateTokenInput {
  accountId: string; // a token can be held by several manual accounts
  tokenId: string;
  symbol: string;
  unitPrice: number;
  amount: number;
}
export type ManualWriteResult = { ok: true } | { ok: false; reason: "overdraw"; symbol?: string };

// Single loader for a manual account's holdings + activities (one read each, no N+1).
// Activities with a null token_id (legacy) are skipped.
const loadTokensWithActivities = (
  accountId: string,
): Effect.Effect<
  { token: ManualHolding; activities: ManualActivity[] }[],
  NotFound,
  Database | DbRequest
> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const [tokens, activities] = yield* Effect.all(
      [store.listHoldings(accountId, NAMER), store.listActivityByAccount(accountId)],
      { concurrency: 2 },
    );
    return foldActivitiesByToken(tokens, activities);
  });

function foldActivitiesByToken(
  tokens: ManualHolding[],
  activities: ManualActivity[],
): { token: ManualHolding; activities: ManualActivity[] }[] {
  const byToken = new Map<string, ManualActivity[]>();
  for (const a of activities) {
    if (a.tokenId == null) continue;
    const arr = byToken.get(a.tokenId) ?? [];
    arr.push(a);
    byToken.set(a.tokenId, arr);
  }
  return tokens.map((token) => ({ token, activities: byToken.get(token.id) ?? [] }));
}

const loadTokens = (accountId: string): Effect.Effect<Token[], NotFound, Database | DbRequest> =>
  Effect.map(loadTokensWithActivities(accountId), (rows) =>
    rows.map(({ token, activities }) => ({
      id: token.id,
      symbol: token.symbol,
      activities,
    })),
  );

// Drawer detail: holdings with ids and derived amounts, plus all activities. The ticket is encoded
// here so the client only ever sees tickets; unrecognised tokens get none.
interface ManualAccountDetailToken {
  id: string;
  symbol: string;
  unitPrice: number | null; // null = never declared; the edit form shows empty, not 0
  ticket: string | null;
  amount: number;
}
export interface ManualAccountDetail {
  tokens: ManualAccountDetailToken[];
  activities: ManualActivity[];
}
export const loadManualAccountDetail = (
  accountId: string,
): Effect.Effect<ManualAccountDetail, NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const [perToken, fiatRefById] = yield* Effect.all(
      [loadTokensWithActivities(accountId), accountFiatRefs(accountId)],
      { concurrency: 2 },
    );
    return {
      tokens: perToken.map(({ token, activities }) => {
        // Fiat has no upstream ref; encode its fiat ref instead, or re-selecting it in the drawer
        // would mint a custom token (`manual/custom:EUR`) instead of the fiat one.
        const ref = token.ref ?? fiatRefById.get(token.id) ?? null;
        return {
          id: token.id,
          symbol: token.symbol,
          // The resolved price (latest in the ledger); the display still prefers market price.
          unitPrice: fallbackUnitPrice(activities),
          ticket: ref ? tokenTicket.encode(ref) : null,
          amount: deriveAmount(activities),
        };
      }),
      activities: perToken.flatMap(({ activities }) => activities),
    };
  });

// Manual accounts have no snapshots, so their history is computed from the ledger.
const loadHistoryTokens = (
  accountId: string,
): Effect.Effect<HistoryToken[], NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const [perToken, fiatRefById] = yield* Effect.all(
      [loadTokensWithActivities(accountId), accountFiatRefs(accountId)],
      { concurrency: 2 },
    );
    return perToken.map(({ token, activities }) => {
      const fiatRef = fiatRefById.get(token.id);
      const fiatCode = fiatRef ? fiatCodeOf(fiatRef) : undefined;
      return {
        id: token.id,
        // Last-resort flat price: only reached when no activity has a price at all.
        unitPrice: 0,
        // Fiat is always recognised (historical price = that day's rate).
        recognized: fiatCode != null || token.ref != null,
        fiatCode,
        activities,
      };
    });
  });

// tokenId → fiat ref within one account; fiat identity exists only under FIAT_NAMER.
const accountFiatRefs = (
  accountId: string,
): Effect.Effect<Map<string, string>, NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const out = new Map<string, string>();
    for (const h of yield* store.listHoldings(accountId, FIAT_NAMER)) {
      if (h.ref && fiatCodeOf(h.ref)) out.set(h.id, h.ref);
    }
    return out;
  });

// Wraps historical prices into the synchronous lookup `buildManualAccountSeries` needs. Cache only,
// no network: daily prices are backfilled by the `daily-prices` job. Missing days are
// forward-filled in memory (never stored); before the first known day it returns undefined and the
// pure layer falls back to ledger prices.
const buildHistoricalPriceAt = (
  tokens: HistoryToken[],
  now: number,
): Effect.Effect<HistoricalPriceAt, never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const { tokens: tokenService, fx } = yield* Oracle;
    const byIdentifier = new Map<string, Map<number, number>>();
    yield* Effect.forEach(
      tokens,
      (tk) =>
        Effect.gen(function* () {
          // Unrecognised tokens have no price history.
          if (!tk.recognized || tk.activities.length === 0 || byIdentifier.has(tk.id)) return;
          const from = Math.min(...tk.activities.map((a) => a.occurredAt));
          // Fiat history = that day's fx rate; others read the token's price history.
          const series = tk.fiatCode
            ? yield* fx.rateSeries(tk.fiatCode as string, from, now)
            : yield* tokenService.priceSeries(tk.id, from, now);
          byIdentifier.set(tk.id, forwardFilled(series, dayBucketOf(now)));
        }),
      // DB reads only; a manual account holds a handful of tokens.
      { concurrency: 1, discard: true },
    );
    return (tokenId: string, t: number) => byIdentifier.get(tokenId)?.get(dayBucketOf(t));
  });

const forwardFilled = (
  series: readonly { atMs: number; unitPrice: number }[],
  throughB: number,
): Map<number, number> => {
  const known = new Map<number, number>();
  for (const pt of series) known.set(dayBucketOf(pt.atMs), pt.unitPrice);
  const out = new Map<number, number>();
  const first = series[0];
  if (!first) return out;
  let last: number | undefined;
  for (let b = dayBucketOf(first.atMs); b <= throughB; b++) {
    last = known.get(b) ?? last;
    if (last !== undefined) out.set(b, last);
  }
  return out;
};

export interface DailyPriceTarget {
  readonly tokenId: string;
  readonly fiatCode?: string;
  /** Earliest activity for this token across the user's manual accounts. */
  readonly fromMs: number;
}

/**
 * Every token the history chart would query, from its earliest activity. Includes archived accounts
 * since history keeps their past contribution.
 */
export const manualDailyPriceTargets = (
  accounts: AccountSafe[],
): Effect.Effect<DailyPriceTarget[], NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const byId = new Map<string, DailyPriceTarget>();
    for (const account of accounts.filter((a) => isManual(a.connectorId))) {
      for (const tk of yield* loadHistoryTokens(account.id)) {
        if (!tk.recognized || tk.activities.length === 0) continue;
        const fromMs = Math.min(...tk.activities.map((a) => a.occurredAt));
        const seen = byId.get(tk.id);
        if (!seen || fromMs < seen.fromMs) {
          byId.set(tk.id, { tokenId: tk.id, fiatCode: tk.fiatCode, fromMs });
        }
      }
    }
    return [...byId.values()];
  });

/** Used for a targeted `daily-prices` refill after a write. */
export const manualAccountTokenIds = (
  accountId: string,
): Effect.Effect<string[], NotFound, Database | DbRequest> =>
  Effect.map(loadTokensWithActivities(accountId), (perToken) => perToken.map((t) => t.token.id));

// `now` is passed so the series ends where the caller's live point is.
export const loadManualAccountSeries = (
  accountId: string,
  now: number = Date.now(),
): Effect.Effect<SnapshotTotalRow[], NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const tokens = yield* loadHistoryTokens(accountId);
    const priceAt = yield* buildHistoricalPriceAt(tokens, now);
    return buildManualAccountSeries(accountId, tokens, now, priceAt);
  });

// Live total for the drawer's chart end point, computed the same way as the header value.
// Missing or foreign account → null.
export const loadManualAccountLiveTotal = (
  accountId: string,
): Effect.Effect<number | null, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const account = yield* Effect.flatMap(Database, (db) => db.accounts.getById(accountId));
    if (!account) return null;
    const byAccount = new Map<string, SnapshotWithBalances>();
    yield* injectManualSnapshots([account], byAccount);
    return byAccount.get(accountId)?.snapshot.totalUsd ?? null;
  });

// Manual ledger rows for portfolio history. Includes archived accounts (their past still counts);
// the caller's live point already drops them from the end.
export const loadManualHistoryRows = (
  accounts: AccountSafe[],
  now: number = Date.now(),
  opts?: { since?: number },
): Effect.Effect<SnapshotTotalRow[], NotFound, Database | Oracle | DbRequest> =>
  Effect.map(
    Effect.forEach(
      accounts.filter((a) => isManual(a.connectorId)),
      (a) =>
        loadManualAccountSeries(a.id, a.archivedAt == null ? now : Math.min(a.archivedAt, now)),
      { concurrency: "unbounded" },
    ),
    (perAccount) =>
      perAccount.flatMap((rows) => {
        const since = opts?.since;
        let clipped = rows;
        if (since != null) {
          const inWindow = rows.filter((r) => r.takenAt >= since);
          // Carry the last pre-window point in at `since`, like snapshot carry-in, so the account
          // is present from the window start.
          const lastBefore = rows.filter((r) => r.takenAt < since).at(-1);
          clipped =
            lastBefore != null && inWindow[0]?.takenAt !== since
              ? [{ ...lastBefore, takenAt: since }, ...inWindow]
              : inWindow;
        }
        // No downsampling here: these rows feed the SQL portfolio timeline whole.
        return clipped;
      }),
  );

// Adds a holding with an opening `set`. Mint returns the same id for a known token, so adding it
// again just resets the amount.
export const createToken = (
  input: CreateTokenInput,
): Effect.Effect<{ id: string }, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const tokenId = yield* mintHolding(input);
    yield* store.setHoldingDef(tokenId, { symbol: input.symbol.trim().toUpperCase() });
    yield* store.recordActivity(input.accountId, tokenId, {
      kind: "set",
      amount: input.amount,
      price: input.unitPrice > 0 ? input.unitPrice : null,
      occurredAt: Date.now(),
    });
    return { id: tokenId };
  });

// Re-binding to a different upstream token is not supported here.
export const updateToken = (
  input: UpdateTokenInput,
): Effect.Effect<void, NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    yield* store.setHoldingDef(input.tokenId, { symbol: input.symbol.trim().toUpperCase() });
    const current = deriveAmount(yield* store.listActivityByToken(input.accountId, input.tokenId));
    // Only when the amount changed; carry the price, since the ledger is the only place it lives.
    if (Math.abs(current - input.amount) > AMOUNT_EPS) {
      yield* store.recordActivity(input.accountId, input.tokenId, {
        kind: "set",
        amount: input.amount,
        price: input.unitPrice > 0 ? input.unitPrice : null,
        occurredAt: Date.now(),
      });
    }
  });

// Removes the account's activities for the token. The `tokens` row stays: it is shared reference
// data other accounts may use.
export const deleteToken = (
  accountId: string,
  tokenId: string,
): Effect.Effect<void, NotFound, Database | DbRequest> =>
  Effect.flatMap(Database, (db) => db.manual.detachHolding(accountId, tokenId));

export const addManualActivities = (
  accountId: string,
  drafts: BatchDraft[],
): Effect.Effect<ManualWriteResult, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const existing = yield* loadTokens(accountId);
    // Mint first so planning compares ids; drafts for the same token share one holding.
    const withIds = yield* Effect.forEach(
      drafts,
      (d) =>
        Effect.map(mintHolding(d.token), (tokenId) => ({
          ...d,
          token: { ...d.token, tokenId },
        })),
      { concurrency: "unbounded" },
    );
    const plan = planManualBatch(existing, withIds);
    if (!plan.ok) return { ok: false, reason: "overdraw", symbol: plan.symbol };
    yield* store.commitBatch({ accountId, declare: plan.declare, activities: plan.activities });
    return { ok: true };
  });

// No oversell check: deleting only removes activity, and the derived amount clamps at 0.
export const deleteManualActivity = (
  accountId: string,
  activityId: string,
): Effect.Effect<void, NotFound, Database | DbRequest> =>
  Effect.flatMap(Database, (db) => db.manual.removeActivity(accountId, activityId));

// Edits can cause an oversell, so re-check the token's timeline with the patch applied.
export const editManualActivity = (
  activityId: string,
  patch: ManualActivityPatch,
): Effect.Effect<ManualWriteResult, NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).manual;
    const { tokenId, accountId } = yield* store.activityOwner(activityId);
    const activities = yield* store.listActivityByToken(accountId, tokenId);
    // Only kind / amount / occurredAt affect the running balance.
    const patched = activities.map((a) =>
      a.id === activityId
        ? {
            kind: patch.kind ?? a.kind,
            amount: patch.amount ?? a.amount,
            occurredAt: patch.occurredAt ?? a.occurredAt,
            createdAt: a.createdAt,
          }
        : a,
    );
    if (!runningOk(patched)) {
      const holdings = yield* store.listHoldings(accountId, NAMER);
      return {
        ok: false,
        reason: "overdraw",
        symbol: holdings.find((t) => t.id === tokenId)?.symbol,
      };
    }
    yield* store.updateActivity(activityId, patch);
    return { ok: true };
  });

// Synthesised 24h-ago snapshot for manual accounts, computed from the ledger at `start`. Accounts
// with no activity at or before `start` are younger than 24h and get none.
export const injectManualPrevSnapshots = (
  accounts: AccountSafe[],
  prevByAccount: Map<string, SnapshotWithBalances>,
  start: number,
  now: number,
): Effect.Effect<void, NotFound, Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    // Archived accounts have no 24h change.
    const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
    yield* Effect.forEach(
      manual,
      (account) =>
        Effect.gen(function* () {
          const tokens = yield* loadHistoryTokens(account.id);
          if (!tokens.some((tk) => tk.activities.some((a) => a.occurredAt <= start))) return;
          const priceAt = yield* buildHistoricalPriceAt(tokens, now);
          const balances = tokens.map((tk, i) => {
            const amount = tokenQuantityAt(tk, start);
            return {
              id: `manual:${account.id}:${i}`,
              snapshotId: `manual:${account.id}`,
              amount,
              // Historical price → latest priced activity → unitPrice.
              usdValue: amount * tokenPriceAt(tk, start, priceAt),
              kind: "spot" as const,
              platform: MANUAL_CONNECTOR_ID,
              selfPrice: null,
              tokenId: tk.id,
              metaJson: null,
            };
          });
          const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
          prevByAccount.set(account.id, {
            snapshot: {
              id: `manual:${account.id}`,
              accountId: account.id,
              takenAt: start,
              totalUsd,
              note: null,
            },
            balances,
          });
        }),
      { concurrency: 1, discard: true },
    );
  });
