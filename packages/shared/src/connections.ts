import { z } from 'zod'

export type SourceKind = 'wallet' | 'exchange' | 'perp' | 'manual'

/** `GET /api/sources`: what the picker and the generated form need about a source plugin. */
export interface SourceInfo {
  id: string
  kind: SourceKind
  label: string
  description: string
  /** JSON Schema of the config; each property may carry `title`, `description`,
   * `placeholder` and `secret`. */
  configSchema: Record<string, unknown>
}

/** A connection as the API returns it: secrets only as the names of the fields that are set. */
export interface ConnectionView {
  id: string
  sourceId: string
  label: string
  config: Record<string, unknown>
  secretsSet: string[]
  status: 'ok' | 'error' | null
  error: { code: string; message: string } | null
  syncedAt: number | null
  createdAt: number
}

export const createConnectionBody = z.object({
  sourceId: z.string().min(1),
  label: z.string().trim().max(60).optional(),
  config: z.record(z.string(), z.unknown()),
})
export type CreateConnectionBody = z.input<typeof createConnectionBody>

/** Omitted secret fields keep their saved values. */
export const updateConnectionBody = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateConnectionBody = z.input<typeof updateConnectionBody>
