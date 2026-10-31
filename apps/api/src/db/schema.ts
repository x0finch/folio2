// The app's tables. drizzle-kit generates migrations from this file.
import type { PerpDetails } from '@folio/sources'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { user } from './auth-schema'

export * from './auth-schema'

/** Key/value facts about the deployment itself (e.g. when FX rates were last refreshed). */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** A user's configured data source: one wallet address, one exchange account, etc. */
export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The plugin id in @folio/sources. */
    sourceId: text('source_id').notNull(),
    label: text('label').notNull(),
    /** Non-secret config fields as JSON. */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Secret config fields, sealed together (crypto.ts); null when the source has none. */
    secrets: text('secrets'),
    /** Last sync outcome: null until the first sync. */
    status: text('status', { enum: ['ok', 'error'] }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('connections_user_idx').on(table.userId)],
)

/**
 * The latest positions of each connection, replaced as a whole by every successful sync of
 * that connection. Prices and values are what the source reported (if anything); pricing adds
 * the rest when the portfolio is read.
 */
export const positions = sqliteTable(
  'positions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name'),
    logo: text('logo'),
    /** Decimal string. */
    amount: text('amount').notNull(),
    kind: text('kind', {
      enum: ['spot', 'staked', 'lending', 'borrowed', 'reward', 'perp'],
    }).notNull(),
    location: text('location'),
    priceUsd: real('price_usd'),
    valueUsd: real('value_usd'),
    perp: text('perp', { mode: 'json' }).$type<PerpDetails>(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('positions_user_idx').on(table.userId),
    index('positions_connection_idx').on(table.connectionId),
  ],
)

/** Latest USD price per asset id. Public market data, shared by every user. */
export const prices = sqliteTable('prices', {
  assetId: text('asset_id').primaryKey(),
  priceUsd: real('price_usd').notNull(),
  /** 24h change as a ratio, when the feed has one. */
  change24h: real('change_24h'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Units of a fiat currency per 1 USD (ECB rates). Public, shared by every user. */
export const fxRates = sqliteTable('fx_rates', {
  currency: text('currency').primaryKey(),
  perUsd: real('per_usd').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  currency: text('currency').notNull(),
  dustUsd: real('dust_usd').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Net worth over time: one row per user per hour, overwritten by later syncs in that hour. */
export const portfolioSnapshots = sqliteTable(
  'portfolio_snapshots',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Start of the hour, epoch ms. */
    hour: integer('hour').notNull(),
    totalUsd: real('total_usd').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.hour] })],
)

/** Each asset's amount and value per user per day (UTC), overwritten by later syncs that day. */
export const assetSnapshots = sqliteTable(
  'asset_snapshots',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Start of the UTC day, epoch ms. */
    day: integer('day').notNull(),
    assetId: text('asset_id').notNull(),
    amount: text('amount').notNull(),
    valueUsd: real('value_usd'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.assetId, table.day] })],
)
