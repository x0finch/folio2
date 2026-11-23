import type { ConnectorId } from "@folio/connectors";
import type { BalanceKind } from "@folio/connectors-basic";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";

// Business account: a tracked balance source. Not the better-auth `account` table in ./auth.
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").$type<ConnectorId>().notNull(),
    // Chain or venue (Platform) of the account, chosen at creation; account-level, unlike the per-holding `snapshot_balances.platform`.
    platform: text("platform"),
    label: text("label").notNull(),
    // Opaque JSON creds map: secret fields are AES-GCM ciphertext, public/semi plaintext. Completeness is judged in memory by `isComplete`. The column keeps its historical name `enc_credentials`.
    creds: text("enc_credentials"),
    createdAt: integer("created_at").notNull(), // epoch ms
    // Non-null = archived (epoch ms): excluded from totals and sync, data kept, reversible.
    archivedAt: integer("archived_at"), // epoch ms
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const portfolios = sqliteTable(
  "portfolios",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [
    index("portfolios_user_id_idx").on(t.userId),
    // The partial unique index is what actually prevents concurrent double defaults; the app-level find-or-create can't (Workers instances don't share a read-then-insert).
    uniqueIndex("portfolios_user_default_uidx").on(t.userId).where(sql`${t.isDefault} = 1`),
    // Names are unique per user, case- and edge-space-insensitive, so two identical-looking portfolios can't coexist and a double-click create is rejected.
    //
    // `trim` matters: without it "x" and "x " would be distinct yet look identical.
    uniqueIndex("portfolios_user_name_uidx").on(t.userId, sql`lower(trim(${t.name}))`),
  ],
);

// Account to Portfolio membership, one-to-one (UNIQUE(account_id)); going M:N later only drops that index. Deleting an account or portfolio cascades the membership row.
export const portfolioAccounts = sqliteTable(
  "portfolio_accounts",
  {
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.portfolioId, t.accountId] }),
    // Doubles as the one-to-one lock and the reverse lookup; drop the unique constraint for M:N.
    uniqueIndex("portfolio_accounts_account_uidx").on(t.accountId),
  ],
);

// Soft tags within a Portfolio (M:N via account_tags); an account can only take tags of its own Portfolio. Cascade-deleted with the Portfolio.
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [
    index("tags_user_id_idx").on(t.userId),
    index("tags_portfolio_id_idx").on(t.portfolioId),
    // Tag names are unique per Portfolio, case-insensitive (lower(name); ops trim first). The real guard against concurrent duplicates.
    uniqueIndex("tags_user_portfolio_name_uidx").on(t.userId, t.portfolioId, sql`lower(${t.name})`),
  ],
);

// Account to Tag (M:N): unlike portfolio_accounts, no UNIQUE(account_id). The account_id index serves clearing an account's tags and reverse lookup.
export const accountTags = sqliteTable(
  "account_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.accountId] }),
    index("account_tags_account_id_idx").on(t.accountId),
  ],
);

// Home-screen custom tabs: thin shortcuts to one Connector or one Tag, borrowing its name/colour; at most 3 per user (checked in ops). `connector_id` has no FK (Connectors are code manifests, not rows). `kind` decides which of the three columns is set; ops enforce it, not the DB.
export const tabPins = sqliteTable(
  "tab_pins",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"connector" | "tag" | "account">().notNull(),
    tagId: text("tag_id").references(() => tags.id, { onDelete: "cascade" }), // tag pins
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }), // account pins
    connectorId: text("connector_id").$type<ConnectorId>(), // connector pins (no FK)
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("tab_pins_user_id_idx").on(t.userId)],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    takenAt: integer("taken_at").notNull(), // epoch ms
    totalUsd: real("total_usd").notNull(),
    // Account-level display notes: JSON.stringify(Note[]), parsed on read; display only.
    note: text("note"),
  },
  (t) => [
    index("snapshots_account_id_idx").on(t.accountId),
    // Latest snapshot per account (greatest-n-per-group) uses this composite index.
    index("snapshots_account_id_taken_at_idx").on(t.accountId, t.takenAt),
  ],
);

export const snapshotBalances = sqliteTable(
  "snapshot_balances",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    amount: real("amount").notNull(),
    usdValue: real("usd_value").notNull(),
    kind: text("kind").$type<BalanceKind>().notNull(),
    // Provider-reported unit price: the frozen raw input to valuation. usd_value is the revalued result; the view derives from amount + self_price + live price + mode, so switching source stays reversible.
    selfPrice: real("self_price"),
    // Chain or venue (Platform) reported by the provider; nullable for older rows, where readers fall back to the account's connectorId.
    platform: text("platform"),
    // Token row id minted before the snapshot write; display names live on the Token row. Required: only the v2 import writes empty values and is meant to fail the constraint.
    //
    // Deliberately no FK: merge re-points history before deleting the old token, and user-delete cascades (tokens via user_id, snapshot_balances via snapshots) run in unspecified order, so an FK would break them. Snapshots are immutable history and shouldn't block reference-layer maintenance; merge tests guard dangling ids.
    tokenId: text("token_id").notNull(),
    metaJson: text("meta_json"), // JSON.stringify(meta)
    // Balance-level display note: JSON.stringify(single Note), parsed on read.
    note: text("note"),
  },
  (t) => [index("snapshot_balances_snapshot_id_idx").on(t.snapshotId)],
);

// Daily rollup of snapshot totals (one row per account per UTC day), maintained by `SnapshotStore.write` in the same batch. Long-window curves read it instead of scanning hourly snapshots.
//
// Derived data: `snapshots` is the truth and this table can be recomputed; export omits it and import rebuilds it via `write`.
//
// No user_id: scoped via `account_id` to `accounts.user_id` (reads must join accounts); cascade-deleted with the account.
//
// Each of the four points stores value + time: open/close by taken_at, min/max extremes (ties take the earliest), so per-account curves can plot extremes at their real time.
export const accountDailyTotals = sqliteTable(
  "account_daily_totals",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    day: integer("day").notNull(), // UTC day start, epoch ms
    openUsd: real("open_usd").notNull(),
    openAt: integer("open_at").notNull(),
    minUsd: real("min_usd").notNull(),
    minAt: integer("min_at").notNull(),
    maxUsd: real("max_usd").notNull(),
    maxAt: integer("max_at").notNull(),
    closeUsd: real("close_usd").notNull(),
    closeAt: integer("close_at").notNull(), // taken_at of the day's last snapshot
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

// Token table: info facet (long TTL) and price facet (short TTL; expired means stale, never deleted, SWR) in one row. Identity is tokens.id (vendor-neutral UUID).
export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(), // UUID
  // Owner: tokens are per-user ("which coins he knows, what he calls them").
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(), // normalised (upper-case)
  name: text("name").notNull(),
  logo: text("logo"), // canonical logo; NULL for provider-only tokens
  providerLogo: text("provider_logo"), // fallback slot: provider-supplied image
  marketCapRank: integer("market_cap_rank"),
  infoExpiresAt: integer("info_expires_at").notNull(), // name/logo long TTL
  unitPrice: real("unit_price"), // price facet (null = no price yet)
  change24h: real("change_24h"),
  priceAsOf: integer("price_as_of"),
  priceExpiresAt: integer("price_expires_at"), // short TTL; expired reads come back stale
  // User-declared unit price (distinct from the market `unit_price`): used only when the market doesn't know the token, never overwritten by upstream.
  //
  // Lives on `tokens`, so it is one price per token, shared by every manual account holding it.
  selfPrice: real("self_price"),
});

// One user's mapping for a namer: "his tk_xxx is <local_name> at <namer>". tokenRef is stored in two columns so the (token_id, namer) index can answer reverse lookups without LIKE.
//
// PK includes user_id: tokens are per-user, so two users holding BTC would collide on (namer, local_name).
//
// The unique index `(user_id, token_id, namer)` is the only real guard for one ref per namer under Workers' non-atomic read-then-write; `linkRef`'s app check only helps within one instance.
//
// Vendor-neutral: the index is on `namer`, not a hardcoded vendor, so it holds for every namer.
export const tokenRefs = sqliteTable(
  "token_refs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    namer: text("namer").notNull(), // tokenRef left part: evm:1 / bitcoin / binance / coingecko
    localName: text("local_name").notNull(), // right part: native / contract:0x... / issued:... / custom:...
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.namer, t.localName] }),
    // One ref per namer per Token; reverse lookups use this index's prefix.
    uniqueIndex("token_refs_token_id_namer_uidx").on(t.userId, t.tokenId, t.namer),
  ],
);

// Global "on-chain address to what a namer calls it". No user_id: public upstream knowledge, rebuildable, refilled daily by cron; sync reads it locally. A controlled exception to user scoping (see also tokenDailyPrices).
// The table holds two refs, so columns carry an `upstream_` prefix:
// chain_ref is the on-chain tokenRef (its left part is the chain namer); upstream is the upstream namer (not a chain); upstream_local_name is the canonical localName (`issued:bitcoin`).
export const globalTokenRefIndex = sqliteTable(
  "global_token_ref_index",
  {
    chainRef: text("chain_ref").notNull(), // on-chain ref: evm:1/contract:0x... / solana/contract:...
    upstream: text("upstream").notNull(), // upstream namer: coingecko / coinmarketcap / ... (not a chain)
    upstreamLocalName: text("upstream_local_name").notNull(), // canonical localName: issued:bitcoin
    updatedAt: integer("updated_at").notNull(), // time of this refresh; rows aren't deleted, so it shows which weren't refreshed
  },
  (t) => [primaryKey({ columns: [t.chainRef, t.upstream] })],
);

// Per-user KV cache with four key kinds: `warm`, `fx:<currency>`, `platform:<key>` (see oracle cache.ts) and `sync-round:<portfolioId>`. Safe to empty (at most one "who failed last round" is lost). Kept per user so it holds only what this user touched.
//
// `expires_at`: SWR "refetch" for the reference keys (kept, read as stale); a heartbeat for sync rounds (unfinished and expired means the worker died; see domains/sync-rounds.ts).
export const userCache = sqliteTable(
  "user_cache",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    k: text("k").notNull(),
    v: text("v").notNull(), // JSON.stringify(any value)
    expiresAt: integer("expires_at").notNull(), // never deleted on expiry: read as stale (SWR)
  },
  (t) => [primaryKey({ columns: [t.userId, t.k] })],
);

// Historical daily prices, keyed globally by tokenRef (one row = a coin's price on a UTC day). Past prices are immutable, so cached forever with no TTL; today's bucket is mutable and never stored here.
//
// No token_id: it is a per-user random UUID, so keying on it would duplicate history per user and hide source switches (cgk to cmc) as seams. `TokenPriceStore.getDaily(tokenId)` translates in the implementation.
//
// One tokenRef column, not two: only forward lookups (`token_ref = ? AND day_bucket IN (...)`) exist.
//
// Pure cache, rebuildable from upstream.
export const tokenDailyPrices = sqliteTable(
  "token_daily_prices",
  {
    tokenRef: text("token_ref").notNull(), // full tokenRef, e.g. coingecko/bitcoin
    dayBucket: integer("day_bucket").notNull(), // floor(atMs / 86_400_000), UTC day index
    unitPrice: real("unit_price").notNull(), // that day's representative price (USD)
  },
  (t) => [primaryKey({ columns: [t.tokenRef, t.dayBucket] })],
);

// Per-user settings: valuation mode (self price vs source price). Reads have defaults (no row means self-first), so rows are upserted only when settings change.
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  valuationMode: text("valuation_mode")
    .$type<"self-first" | "source-first">()
    .notNull()
    .default("self-first"),
  // Privacy: blur on-screen amounts when on. Account-level, default off; fail-closed before settings load is the client's job.
  hideBalances: integer("hide_balances", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(), // epoch ms
});

// Manual activity ledger (add/reduce/set): the only source of truth for manual holdings; amounts are derived by deriveAmount, not stored. `price` is kept for cost/P&L later.
//
// A manual account's coins are the tokens appearing in its ledger; identity, name, logo and refs live in `tokens` + `token_refs`, declared price in `tokens.self_price`.
export const manualActivity = sqliteTable(
  "manual_activity",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Owning token (`tokens.id`). Nullable at DB level (legacy rows), always set by the app. Deleting a token cascades its activity.
    tokenId: text("token_id").references(() => tokens.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"add" | "reduce" | "set">().notNull(),
    amount: real("amount").notNull(),
    price: real("price"), // unit price (nullable)
    fee: real("fee"), // fee in USD (nullable; cost-basis data, not part of quantity folding)
    occurredAt: integer("occurred_at").notNull(), // epoch ms
    memo: text("memo"), // user-written memo
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("manual_activity_account_id_occurred_at_idx").on(t.accountId, t.occurredAt),
    // The per-token fold (deriveAmount) uses this: activity by token, occurredAt ascending.
    index("manual_activity_token_id_occurred_at_idx").on(t.tokenId, t.occurredAt),
  ],
);

// Per-user data version: bumped by any visible data change, so the browser's persisted query cache asks only this number (`getDataVersion`) and refetches on change.
// Maintained by triggers (hand-written in migration 0010; drizzle-kit ignores them), not by write ops: each owner-bearing table has AFTER INSERT/UPDATE/DELETE triggers upserting this row in the same statement, so no op can forget. `data-version.test.ts` counts triggers against sqlite_master.
//
// Deliberately not triggered: `snapshot_balances` / `account_daily_totals` (written in the snapshots batch; per-row bumps waste D1 write rows), `user_cache`, and `token_refs` / `tokens` price and info refreshes (only symbol / name / self_price changes bump).
//
// User-delete cascades are guarded by `EXISTS (SELECT 1 FROM user ...)` so triggers don't re-insert version rows and hit the FK.
//
// A migration rebuilding a table that triggers reference must drop all triggers first and recreate them at the end (`pnpm db:triggers`).
export const userDataVersion = sqliteTable("user_data_version", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(0),
});
