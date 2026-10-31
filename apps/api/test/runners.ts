import type { Source } from '@folio/sources'

import { getDb } from '../src/db'
import type { Env } from '../src/env'
import { createRegistry } from '../src/sources'
import { type EngineStorage, SyncEngine } from '../src/sync/engine'

/** In-memory Durable Object storage with a manually fired alarm. */
export class MemoryStorage implements EngineStorage {
  readonly data = new Map<string, unknown>()
  alarmAt: number | null = null

  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value))
  }
  async getAlarm() {
    return this.alarmAt
  }
  async setAlarm(time: number) {
    this.alarmAt = time
  }
}

/**
 * Stand-ins for the SYNC_RUNNER namespace: one SyncEngine per user name, backed by memory.
 * Tests fire alarms explicitly with `runAlarms`.
 */
export function fakeRunners(options: {
  db: () => D1Database
  sources: readonly Source[]
  encryptionSecret: string
  fetch: typeof fetch
  clock: { now: number }
}) {
  const engines = new Map<string, { engine: SyncEngine; storage: MemoryStorage }>()
  const registry = createRegistry(options.sources)

  function runner(name: string) {
    let entry = engines.get(name)
    if (!entry) {
      const storage = new MemoryStorage()
      const engine = new SyncEngine({
        storage,
        db: getDb(options.db()),
        sources: registry,
        encryptionSecret: options.encryptionSecret,
        fetch: options.fetch,
        now: () => options.clock.now,
      })
      entry = { engine, storage }
      engines.set(name, entry)
    }
    return entry
  }

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => ({
      enqueue: (userId: string, ids?: string[]) => runner(name).engine.enqueue(userId, ids),
      status: () => runner(name).engine.status(),
    }),
  } as unknown as Env['SYNC_RUNNER']

  /** Fires due alarms for a user until none is due at the current clock. */
  async function runAlarms(userId: string, max = 20) {
    const { engine, storage } = runner(userId)
    for (let i = 0; i < max; i += 1) {
      if (storage.alarmAt === null || storage.alarmAt > options.clock.now) return i
      storage.alarmAt = null
      await engine.alarm()
    }
    throw new Error('Alarms kept re-arming')
  }

  return { namespace, runAlarms, runner }
}
