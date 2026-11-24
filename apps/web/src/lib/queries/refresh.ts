import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { accountKeys, portfolioKeys, settingsKeys, syncKeys, tagKeys, tokenKeys } from "./keys";

// Refresh map: a write's semantics -> the key prefixes it changes. A missed refresh raises no error and only
// shows as a screen that doesn't update, so the prefixes live in one reviewable table and call sites only say what they did.
// Names are `<domain>.<action>`. List cross-domain effects too (account add/remove also changes the portfolio domain's
// totals). The test for each entry: which server reads return something different after this write? Trace into
// `lib/server/*` and `packages/db` to see which tables change; the call-site name doesn't show it.
// Prefixes align with atom keys (`portfolio.snapshots`, `tokens.enrichment`), not the removed fat reads.
export const REFRESH_MAP = {
  /**
   * A sync round advanced or finished (failure counts too: sync may still run in the queue and some snapshots may be stored).
   * Refreshes snapshot atoms, the account list and enrichment prices, but NOT the sync domain: this event fires when the
   * round query itself read new progress, so marking it stale would cost an extra `getSyncRound` per step.
   */
  "sync.round": [portfolioKeys.snapshotsPrefix(), accountKeys.all, tokenKeys.enrichment()],

  /** The drawer's single-account sync: same prefixes as a round, smaller scope. */
  "account.sync": [
    syncKeys.all,
    portfolioKeys.snapshotsPrefix(),
    accountKeys.all,
    tokenKeys.enrichment(),
  ],

  /**
   * Account and manual-asset writes (create / update / archive / delete, credential replace, manual tokens / activities):
   * account rows, sync round, dataStats, manual fiat identity. Snapshots too: manual accounts never sync, their
   * balances are computed at read time by `injectManualSnapshots`, so skipping them leaves home totals, account rows and
   * insights stale.
   */
  "account.write": [
    accountKeys.all,
    syncKeys.all,
    settingsKeys.dataStats(),
    portfolioKeys.fiatRefsPrefix(),
    tokenKeys.enrichment(),
    portfolioKeys.snapshotsPrefix(),
  ],

  /** Archive / unarchive: `account.write`'s prefixes plus the tab strip (sealed manual snapshot, unpin). */
  "account.archive": [
    accountKeys.all,
    syncKeys.all,
    settingsKeys.dataStats(),
    portfolioKeys.fiatRefsPrefix(),
    tokenKeys.enrichment(),
    portfolioKeys.snapshotsPrefix(),
    portfolioKeys.tabs(),
  ],

  /**
   * Tag create / rename / delete and tagging accounts. Refreshes the tag domain only: badges, the picker and tab-strip
   * subtotals follow, and the overview is composed in the browser from `accountTagLinks`, so snapshot keys stay valid.
   */
  "tag.write": [tagKeys.all],

  /**
   * Portfolio create / rename / delete, set default, move account. Also refresh the tag domain: tags belong to a portfolio,
   * and moving an account (`portfolioStore.move` deletes `accountTags`) or deleting a portfolio (FK cascade) removes tag
   * links, so otherwise ghost tags remain with no error. Also the account and sync domains: account data is filtered
   * per portfolio on the server, so membership changes must reload them and the header sync summary.
   */
  "portfolio.write": [portfolioKeys.all, tagKeys.all, accountKeys.all, syncKeys.all],

  /** Custom tab create / retarget / delete. Tab strip only: tabs change no balance, so refetching the overview is waste. */
  "portfolio.pin.write": [portfolioKeys.tabs()],

  // Display currency / UI language aren't here: both live in the browser and are in query keys, so a new value is a new key.

  /** Valuation mode change: read-time revaluation, so history isn't recomputed, but overview / trend / holdings values recompute in the browser. */
  "settings.valuation": [settingsKeys.valuation()],

  /** Import: anything may change, so every domain is listed; omitting one leaves a block of the screen stale. */
  "settings.data": [
    settingsKeys.all,
    syncKeys.all,
    portfolioKeys.all,
    accountKeys.all,
    tagKeys.all,
    tokenKeys.enrichment(),
  ],

  /**
   * The server's data version changed (another tab / device / background sync wrote): anything may change, so the same
   * prefixes as `settings.data`. This page's own writes still use the targeted entries above (see `data-version.ts`).
   */
  "data.changed": [
    settingsKeys.all,
    syncKeys.all,
    portfolioKeys.all,
    accountKeys.all,
    tagKeys.all,
    tokenKeys.enrichment(),
  ],
} satisfies Record<string, readonly QueryKey[]>;

export type RefreshEvent = keyof typeof REFRESH_MAP;

// Returns a Promise so callers can await the refresh (e.g. before removing an optimistic overlay).
// `invalidateQueries` only refetches mounted queries and marks the rest stale, so no per-page narrowing is needed.
export const invalidateFor = (queryClient: QueryClient, event: RefreshEvent): Promise<void> =>
  Promise.all(
    REFRESH_MAP[event].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);
