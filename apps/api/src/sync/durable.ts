import { DurableObject } from 'cloudflare:workers'

import { getDb } from '../db'
import type { Env } from '../env'
import { priceUser } from '../pricing/store'
import { defaultRegistry } from '../sources'
import { SyncEngine } from './engine'
import { schedulePage } from './schedule'

/**
 * One per user (named by user id). Durable Object alarms get far more CPU than a request on
 * the free plan, so all upstream fetching happens here. Only SQLite-backed objects exist on
 * the free plan; the engine uses the storage API on top of it.
 */
export class SyncRunner extends DurableObject<Env> {
  private engine() {
    return new SyncEngine({
      storage: this.ctx.storage,
      db: getDb(this.env.DB),
      sources: defaultRegistry,
      encryptionSecret: this.env.ENCRYPTION_SECRET,
      fetch: (input, init) => fetch(input, init),
      onFinished: (userId) =>
        priceUser(getDb(this.env.DB), (input, init) => fetch(input, init), userId, Date.now()),
    })
  }

  enqueue(userId: string, connectionIds?: string[]) {
    return this.engine().enqueue(userId, connectionIds)
  }

  status() {
    return this.engine().status()
  }

  override async alarm() {
    await this.engine().alarm()
  }
}

/**
 * A single instance ("global"). The hourly cron calls `kick`; the alarm then pages through the
 * users with connections and enqueues each on their runner, so the cron handler stays tiny.
 */
export class Scheduler extends DurableObject<Env> {
  async kick() {
    if ((await this.ctx.storage.getAlarm()) !== null) return
    await this.ctx.storage.put('cursor', '')
    await this.ctx.storage.setAlarm(Date.now())
  }

  override async alarm() {
    const cursor = (await this.ctx.storage.get<string>('cursor')) ?? ''
    const next = await schedulePage(getDb(this.env.DB), cursor, (userId) =>
      this.env.SYNC_RUNNER.get(this.env.SYNC_RUNNER.idFromName(userId)).enqueue(userId),
    )
    if (next === null) {
      await this.ctx.storage.delete('cursor')
      return
    }
    await this.ctx.storage.put('cursor', next)
    await this.ctx.storage.setAlarm(Date.now())
  }
}
