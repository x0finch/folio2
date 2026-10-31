import { z } from 'zod'

/** `GET /api/sync`: where the user's sync stands. Per-connection results live on connections. */
export interface SyncStatus {
  /** Connections still waiting (including ones retrying later). */
  queued: string[]
  running: boolean
  startedAt: number | null
  finishedAt: number | null
}

/** `POST /api/sync`: refresh one connection, or all of them when omitted. */
export const startSyncBody = z.object({ connectionId: z.string().min(1).optional() })
export type StartSyncBody = z.input<typeof startSyncBody>
