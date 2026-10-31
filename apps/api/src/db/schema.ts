// The app's tables. drizzle-kit generates migrations from this file.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
