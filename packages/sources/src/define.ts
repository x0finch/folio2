import type { SourceInfo, SourceKind } from '@folio/shared'
import { z } from 'zod'

import type { BudgetedFetch } from './fetch'
import type { Position } from './position'

/**
 * Metadata on a config field, attached with zod's `.meta()`. The web app builds the form from
 * the config's JSON Schema, and the API encrypts `secret` fields before storing them.
 */
export interface FieldMeta {
  title: string
  description?: string
  placeholder?: string
  /** Encrypted at rest, never returned by the API, never logged. */
  secret?: boolean
}

/** Marks a string field as a secret with form metadata. */
export const secret = (meta: Omit<FieldMeta, 'secret'>) =>
  z
    .string()
    .trim()
    .min(1)
    .meta({ ...meta, secret: true })

/** A required string field with form metadata. */
export const field = (meta: Omit<FieldMeta, 'secret'>) => z.string().trim().min(1).meta(meta)

export interface SourceLog {
  info(message: string, data?: Record<string, string | number | boolean>): void
  warn(message: string, data?: Record<string, string | number | boolean>): void
}

/** What a plugin gets when it runs. Never includes the database or other plugins. */
export interface SourceContext<Config> {
  /** The connection's config, secrets decrypted. Don't log it. */
  config: Config
  fetch: BudgetedFetch
  log: SourceLog
  now: Date
}

export interface Source<Schema extends z.ZodObject = z.ZodObject> {
  /** Stable id stored with every connection. Never rename. */
  id: string
  kind: SourceKind
  /** Shown in the source picker. */
  label: string
  /** One line under the label in the picker. */
  description: string
  config: Schema
  /** The most subrequests one fetch may need; the sync engine defers it when less is left. */
  maxRequests: (config: z.output<Schema>) => number
  /** A short, non-secret name for a new connection, e.g. a shortened address. */
  defaultLabel: (config: z.output<Schema>) => string
  /** Checks the config against the upstream when a connection is saved. */
  validate?: (ctx: SourceContext<z.output<Schema>>) => Promise<void>
  fetchPositions: (ctx: SourceContext<z.output<Schema>>) => Promise<Position[]>
}

/** Declares a source plugin; only a typed identity function. */
export function defineSource<Schema extends z.ZodObject>(source: Source<Schema>): Source<Schema> {
  return source
}

function isSecretMeta(meta: unknown): boolean {
  return typeof meta === 'object' && meta !== null && 'secret' in meta && meta.secret === true
}

/** Names of the config fields marked secret. */
export function secretFields(source: Source): string[] {
  return Object.entries(source.config.shape)
    .filter(([, schema]) => isSecretMeta(schema.meta()))
    .map(([name]) => name)
}

/** The public description of a source, for the picker and the generated form. */
export function describeSource(source: Source): SourceInfo {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    description: source.description,
    configSchema: z.toJSONSchema(source.config, { io: 'input' }),
  }
}
