import type { ConnectionView } from '@folio/shared'
import { type Source, secretFields } from '@folio/sources'
import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'

import { open, seal } from './crypto'
import type { Db } from './db'
import { connections } from './db/schema'

type Row = typeof connections.$inferSelect

/** Binds a sealed blob to its row: copied elsewhere, it doesn't open. */
const sealContext = (userId: string, id: string) => `${userId}/${id}`

/** Splits a parsed config into the stored public part and the secret part. */
export function splitConfig(source: Source, config: Record<string, unknown>) {
  const secretNames = new Set(secretFields(source))
  const publicPart: Record<string, unknown> = {}
  const secretPart: Record<string, string> = {}
  for (const [name, value] of Object.entries(config)) {
    if (secretNames.has(name)) {
      if (typeof value === 'string') secretPart[name] = value
    } else publicPart[name] = value
  }
  return { publicPart, secretPart }
}

export function toView(row: Row, source: Source | undefined): ConnectionView {
  return {
    id: row.id,
    sourceId: row.sourceId,
    label: row.label,
    config: row.config,
    // Every secret field is required, so a sealed blob means all of them are set.
    secretsSet: row.secrets && source ? secretFields(source) : [],
    status: row.status,
    error:
      row.status === 'error'
        ? { code: row.errorCode ?? 'upstream', message: row.errorMessage ?? '' }
        : null,
    syncedAt: row.syncedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  }
}

export function listConnections(db: Db, userId: string) {
  return db
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .orderBy(desc(connections.createdAt))
}

export async function getConnection(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.id, id)))
  return row
}

/** The full config of a row, secrets opened. Only for running or validating the plugin. */
export async function openConfig(row: Row, encryptionSecret: string) {
  const secrets = row.secrets
    ? await open(encryptionSecret, row.secrets, sealContext(row.userId, row.id))
    : {}
  return { ...row.config, ...secrets }
}

export async function insertConnection(
  db: Db,
  encryptionSecret: string,
  values: {
    id: string
    userId: string
    source: Source
    label: string
    config: z.output<Source['config']>
  },
) {
  const { publicPart, secretPart } = splitConfig(values.source, values.config)
  const now = new Date()
  const [row] = await db
    .insert(connections)
    .values({
      id: values.id,
      userId: values.userId,
      sourceId: values.source.id,
      label: values.label,
      config: publicPart,
      secrets: Object.keys(secretPart).length
        ? await seal(encryptionSecret, secretPart, sealContext(values.userId, values.id))
        : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row
}

export async function updateConnection(
  db: Db,
  encryptionSecret: string,
  row: Row,
  source: Source,
  changes: { label?: string; config?: z.output<Source['config']> },
) {
  const set: Partial<typeof connections.$inferInsert> = { updatedAt: new Date() }
  if (changes.label !== undefined) set.label = changes.label
  if (changes.config) {
    const { publicPart, secretPart } = splitConfig(source, changes.config)
    set.config = publicPart
    set.secrets = Object.keys(secretPart).length
      ? await seal(encryptionSecret, secretPart, sealContext(row.userId, row.id))
      : null
  }
  const [updated] = await db
    .update(connections)
    .set(set)
    .where(and(eq(connections.userId, row.userId), eq(connections.id, row.id)))
    .returning()
  return updated
}

export function deleteConnection(db: Db, userId: string, id: string) {
  return db
    .delete(connections)
    .where(and(eq(connections.userId, userId), eq(connections.id, id)))
    .returning({ id: connections.id })
}
