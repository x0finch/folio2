// The app's tables. Each slice adds its own; drizzle-kit generates migrations from this file.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Key/value facts about the deployment itself (e.g. when FX rates were last refreshed). */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
