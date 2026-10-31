import type { SyncStatus } from '@folio/shared'
import { type Position, budgetedFetch, toSourceError } from '@folio/sources'
import { and, asc, eq } from 'drizzle-orm'

import { openConfig } from '../connections'
import type { Db } from '../db'
import { connections, positions } from '../db/schema'
import { newId } from '../ids'
import { consoleLog } from '../log'
import type { SourceRegistry } from '../types'
import { FETCH_BUDGET_PER_ALARM, MAX_ATTEMPTS, WALL_BUDGET_MS, retryDelayMs } from './constants'

interface QueueEntry {
  connectionId: string
  attempts: number
  /** Epoch ms before which it waits (retry backoff). */
  notBefore: number
}

interface State {
  userId: string | null
  queue: QueueEntry[]
  /** The queue emptied; the finishing step (pricing, snapshot) runs in the next alarm. */
  finishing: boolean
  startedAt: number | null
  finishedAt: number | null
}

const EMPTY: State = {
  userId: null,
  queue: [],
  finishing: false,
  startedAt: null,
  finishedAt: null,
}

/** The parts of Durable Object storage the engine uses; tests pass an in-memory one. */
export interface EngineStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  getAlarm(): Promise<number | null>
  setAlarm(time: number): Promise<void>
}

export interface EngineDeps {
  storage: EngineStorage
  db: Db
  sources: SourceRegistry
  encryptionSecret: string
  fetch: typeof fetch
  now?: () => number
  /**
   * Runs once the queue is empty, in an alarm of its own so it has a full subrequest budget:
   * pricing, then the snapshot.
   */
  onFinished?: (userId: string) => Promise<void>
}

/**
 * One user's sync queue, driven by Durable Object alarms. Each alarm runs as many queued
 * connections as fit in the per-invocation budget, writes their positions, and re-arms itself
 * until the queue is empty.
 */
export class SyncEngine {
  private readonly now: () => number

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now
  }

  private async state(): Promise<State> {
    return (await this.deps.storage.get<State>('state')) ?? EMPTY
  }

  private async save(state: State) {
    await this.deps.storage.put('state', state)
  }

  /** Queues the user's connections (all, or the given ones) and makes sure an alarm runs. */
  async enqueue(userId: string, connectionIds?: string[]): Promise<SyncStatus> {
    const state = await this.state()
    if (state.userId && state.userId !== userId) throw new Error('Runner belongs to another user')
    const ids =
      connectionIds ??
      (
        await this.deps.db
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.userId, userId))
          .orderBy(asc(connections.createdAt))
      ).map((row) => row.id)
    const now = this.now()
    const queued = new Set(state.queue.map((entry) => entry.connectionId))
    const queue = [...state.queue]
    for (const id of ids) {
      if (!queued.has(id)) queue.push({ connectionId: id, attempts: 0, notBefore: now })
    }
    const next: State = {
      ...state,
      userId,
      queue,
      startedAt: state.queue.length ? state.startedAt : queue.length ? now : state.startedAt,
    }
    await this.save(next)
    if (queue.length && (await this.deps.storage.getAlarm()) === null) {
      await this.deps.storage.setAlarm(now)
    }
    return this.toStatus(next)
  }

  async status(): Promise<SyncStatus> {
    return this.toStatus(await this.state())
  }

  private toStatus(state: State): SyncStatus {
    return {
      queued: state.queue.map((entry) => entry.connectionId),
      running: state.queue.length > 0 || state.finishing,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    }
  }

  /** The alarm handler: works through due connections within the budget. */
  async alarm(): Promise<void> {
    const state = await this.state()
    const userId = state.userId
    if (!userId) return
    if (!state.queue.length) {
      if (!state.finishing) return
      try {
        await this.deps.onFinished?.(userId)
      } catch (error) {
        // Positions are saved; prices catch up on the next sync.
        consoleLog({ userId }).warn('finishing failed', { error: String(error) })
      }
      await this.save({ ...state, finishing: false, finishedAt: this.now() })
      return
    }
    const started = this.now()
    let fetchesLeft = FETCH_BUDGET_PER_ALARM
    const remaining: QueueEntry[] = []

    for (const entry of state.queue) {
      const due = entry.notBefore <= this.now()
      const outOfTime = this.now() - started > WALL_BUDGET_MS
      if (!due || outOfTime) {
        remaining.push(entry)
        continue
      }
      // Sequential on purpose: each run spends from the shared fetch budget.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await this.runOne(userId, entry, fetchesLeft)
      if (outcome.kind === 'deferred') remaining.push(entry)
      else {
        fetchesLeft -= outcome.used
        if (outcome.kind === 'retry') remaining.push(outcome.entry)
      }
    }

    const finished = remaining.length === 0
    await this.save({ ...state, queue: remaining, finishing: finished })
    if (finished) {
      await this.deps.storage.setAlarm(this.now())
      return
    }
    // Continue right away if something is due, else when the earliest retry is.
    const nextDue = Math.min(...remaining.map((entry) => entry.notBefore))
    await this.deps.storage.setAlarm(Math.max(nextDue, this.now()))
  }

  private async runOne(
    userId: string,
    entry: QueueEntry,
    fetchesLeft: number,
  ): Promise<
    | { kind: 'done'; used: number }
    | { kind: 'retry'; used: number; entry: QueueEntry }
    | { kind: 'deferred' }
  > {
    const { db, sources } = this.deps
    const [row] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.id, entry.connectionId)))
    // Deleted while queued: nothing to do.
    if (!row) return { kind: 'done', used: 0 }
    const source = sources.get(row.sourceId)
    if (!source) {
      await this.markError(userId, row.id, 'invalid_config', `Unknown source ${row.sourceId}`)
      return { kind: 'done', used: 0 }
    }

    let config
    try {
      config = source.config.parse(await openConfig(row, this.deps.encryptionSecret))
    } catch {
      await this.markError(userId, row.id, 'invalid_config', 'The saved settings are not valid')
      return { kind: 'done', used: 0 }
    }
    const need = source.maxRequests(config)
    // Too little budget left in this invocation: the next alarm picks it up. A connection
    // that needs more than a whole alarm's budget still runs, capped at that budget.
    if (need > fetchesLeft && fetchesLeft < FETCH_BUDGET_PER_ALARM) return { kind: 'deferred' }
    const fetch = budgetedFetch(this.deps.fetch, Math.min(need, FETCH_BUDGET_PER_ALARM))
    const log = consoleLog({ connectionId: row.id, sourceId: source.id })

    try {
      const result = await source.fetchPositions({ config, fetch, log, now: new Date(this.now()) })
      await this.writePositions(userId, row.id, result)
      return { kind: 'done', used: fetch.budget.used }
    } catch (caught) {
      const error = toSourceError(caught)
      log.warn('sync failed', { code: error.code, attempt: entry.attempts + 1 })
      if (error.transient && entry.attempts + 1 < MAX_ATTEMPTS) {
        const attempts = entry.attempts + 1
        return {
          kind: 'retry',
          used: fetch.budget.used,
          entry: { ...entry, attempts, notBefore: this.now() + retryDelayMs(attempts) },
        }
      }
      await this.markError(userId, row.id, error.code, error.message)
      return { kind: 'done', used: fetch.budget.used }
    }
  }

  /** Replaces the connection's positions and marks it synced, atomically. */
  private async writePositions(userId: string, connectionId: string, result: Position[]) {
    const { db } = this.deps
    const now = new Date(this.now())
    const rows = result.map((position) => ({
      id: newId(),
      userId,
      connectionId,
      assetId: position.asset.id,
      symbol: position.asset.symbol,
      name: position.asset.name ?? null,
      logo: position.asset.logo ?? null,
      amount: position.amount,
      kind: position.kind,
      location: position.location ?? null,
      priceUsd: position.priceUsd ?? null,
      valueUsd: position.valueUsd ?? null,
      perp: position.perp ?? null,
      updatedAt: now,
    }))
    const scope = and(eq(positions.userId, userId), eq(positions.connectionId, connectionId))
    await db.batch([
      db.delete(positions).where(scope),
      // D1 caps bound parameters per statement; 14 columns × 6 rows stays under 100.
      ...chunk(rows, 6).map((part) => db.insert(positions).values(part)),
      db
        .update(connections)
        .set({ status: 'ok', errorCode: null, errorMessage: null, syncedAt: now })
        .where(and(eq(connections.userId, userId), eq(connections.id, connectionId))),
    ])
  }

  private async markError(userId: string, connectionId: string, code: string, message: string) {
    await this.deps.db
      .update(connections)
      .set({ status: 'error', errorCode: code, errorMessage: message.slice(0, 300) })
      .where(and(eq(connections.userId, userId), eq(connections.id, connectionId)))
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size))
  return parts
}
