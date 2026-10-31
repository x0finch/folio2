// The app's tables. drizzle-kit generates migrations from this file.
import type { PerpDetails } from '@folio/sources'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
