import { SourceError, defineSource, field, manual } from '@folio/sources'
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'

import { getDb } from '../src/db'
import { FETCH_BUDGET_PER_ALARM } from '../src/sync/constants'
import { schedulePage } from '../src/sync/schedule'
import { createTestApp } from './app'

/** Makes `config.requests` fetches; fails as told by `config.mode`. */
const probe = defineSource({
  id: 'probe',
  kind: 'wallet',
  label: 'Probe',
  description: 'For tests',
  config: z.object({
    address: field({ title: 'Address' }),
    requests: z.number().int().min(0),
    mode: z.enum(['ok', 'unauthorized', 'flaky']),
  }),
  maxRequests: (config) => config.requests,
  defaultLabel: (config) => config.address,
  fetchPositions: async ({ config, fetch }) => {
    for (let i = 0; i < config.requests; i += 1) await fetch(`https://probe.test/${i}`)
    if (config.mode === 'unauthorized') throw new SourceError('unauthorized', 'Key revoked')
    if (config.mode === 'flaky' && flakyFailures.count > 0) {
      flakyFailures.count -= 1
      throw new SourceError('rate_limited', 'Slow down')
    }
    return [
      { asset: { id: 'coingecko:ethereum', symbol: 'ETH' }, amount: '2', kind: 'spot' },
      { asset: { id: 'ethereum:0xa0b8', symbol: 'USDC' }, amount: '100.5', kind: 'spot' },
    ]
  },
})
const flakyFailures = { count: 0 }

let t: Awaited<ReturnType<typeof createTestApp>>
const fetched: string[] = []

async function setup() {
  fetched.length = 0
  t = await createTestApp(
    {},
    {
      sources: [manual, probe],
      fetch: async (input) => {
        fetched.push(input instanceof Request ? input.url : input.toString())
        return Response.json({})
      },
    },
  )
  return t.signIn()
}
afterEach(() => t.dispose())

async function addProbe(
  headers: Headers,
  config: { requests: number; mode: 'ok' | 'unauthorized' | 'flaky' },
  address = 'addr',
) {
  const res = await t.send('POST', '/api/connections', headers, {
    sourceId: 'probe',
    config: { address, ...config },
  })
  const body: { id: string } = await res.json()
  return body.id
}

async function positionsOf(connectionId: string) {
  const { results } = await t.env.DB.prepare(
    'select asset_id, amount from positions where connection_id = ? order by asset_id',
  )
    .bind(connectionId)
    .all()
  return results
}

describe('sync engine', () => {
  test('enqueue → alarm → positions written and connection marked synced', async () => {
    const { headers, user } = await setup()
    const id = await addProbe(headers, { requests: 2, mode: 'ok' })

    const started = await t.send('POST', '/api/sync', headers, {})
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ queued: [id], running: true })

    await t.runners.runAlarms(user.id)
    expect(await positionsOf(id)).toEqual([
      { asset_id: 'coingecko:ethereum', amount: '2' },
      { asset_id: 'ethereum:0xa0b8', amount: '100.5' },
    ])
    const [view] = (await (await t.send('GET', '/api/connections', headers)).json()) as {
      status: string
      syncedAt: number
    }[]
    expect(view).toMatchObject({ status: 'ok', syncedAt: t.clock.now })
    expect(await (await t.send('GET', '/api/sync', headers)).json()).toMatchObject({
      queued: [],
      running: false,
      finishedAt: t.clock.now,
    })
  })

  test('a second sync replaces the positions instead of adding to them', async () => {
    const { headers, user } = await setup()
    const id = await addProbe(headers, { requests: 0, mode: 'ok' })
    await t.send('POST', '/api/sync', headers, {})
    await t.runners.runAlarms(user.id)
    await t.send('POST', '/api/sync', headers, {})
    await t.runners.runAlarms(user.id)
    expect(await positionsOf(id)).toHaveLength(2)
  })

  test('a failing source marks only its own connection', async () => {
    const { headers, user } = await setup()
    const bad = await addProbe(headers, { requests: 1, mode: 'unauthorized' }, 'bad')
    const good = await addProbe(headers, { requests: 1, mode: 'ok' }, 'good')
    await t.send('POST', '/api/sync', headers, {})
    await t.runners.runAlarms(user.id)

    const views = (await (await t.send('GET', '/api/connections', headers)).json()) as {
      id: string
      status: string
      error: unknown
    }[]
    expect(views.find((view) => view.id === bad)).toMatchObject({
      status: 'error',
      error: { code: 'unauthorized', message: 'Key revoked' },
    })
    expect(views.find((view) => view.id === good)).toMatchObject({ status: 'ok', error: null })
    expect(await positionsOf(good)).toHaveLength(2)
  })

  test('transient failures retry with backoff, then succeed', async () => {
    const { headers, user } = await setup()
    flakyFailures.count = 1
    const id = await addProbe(headers, { requests: 0, mode: 'flaky' })
    await t.send('POST', '/api/sync', headers, {})
    await t.runners.runAlarms(user.id)
    expect(await positionsOf(id)).toEqual([])
    expect(await (await t.send('GET', '/api/sync', headers)).json()).toMatchObject({
      queued: [id],
      running: true,
    })

    t.clock.now += 30_000
    await t.runners.runAlarms(user.id)
    expect(await positionsOf(id)).toHaveLength(2)
  })

  test('each alarm stays within the fetch budget', async () => {
    const { headers, user } = await setup()
    const big = FETCH_BUDGET_PER_ALARM - 5
    for (const address of ['a', 'b', 'c'])
      await addProbe(headers, { requests: big, mode: 'ok' }, address)
    await t.send('POST', '/api/sync', headers, {})

    const { storage, engine } = t.runners.runner(user.id)
    const perAlarm: number[] = []
    while (storage.alarmAt !== null) {
      storage.alarmAt = null
      const before = fetched.length
      await engine.alarm()
      perAlarm.push(fetched.length - before)
    }
    // Three source alarms, then the finishing alarm.
    expect(perAlarm).toEqual([big, big, big, 0])
    for (const count of perAlarm) expect(count).toBeLessThanOrEqual(FETCH_BUDGET_PER_ALARM)
  })

  test('re-enqueueing while queued does not duplicate work', async () => {
    const { headers, user } = await setup()
    const id = await addProbe(headers, { requests: 1, mode: 'ok' })
    await t.send('POST', '/api/sync', headers, {})
    const again = await t.send('POST', '/api/sync', headers, { connectionId: id })
    expect(await again.json()).toMatchObject({ queued: [id] })
    await t.runners.runAlarms(user.id)
    expect(fetched).toHaveLength(1)
  })

  test("refreshing someone else's connection is not found", async () => {
    const alice = await setup()
    const id = await addProbe(alice.headers, { requests: 0, mode: 'ok' })
    const bob = await t.signIn('Bob')
    const res = await t.send('POST', '/api/sync', bob.headers, { connectionId: id })
    expect(res.status).toBe(404)
  })

  test('connections deleted while queued are skipped', async () => {
    const { headers, user } = await setup()
    const id = await addProbe(headers, { requests: 1, mode: 'ok' })
    await t.send('POST', '/api/sync', headers, {})
    await t.send('DELETE', `/api/connections/${id}`, headers)
    await t.runners.runAlarms(user.id)
    expect(fetched).toHaveLength(0)
  })
})

describe('scheduler', () => {
  test('pages through every user with connections', async () => {
    await setup()
    const users = []
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      const { headers, user } = await t.signIn(name)
      if (name !== 'C') await addProbe(headers, { requests: 0, mode: 'ok' })
      users.push(user.id)
    }
    const enqueued: string[] = []
    let cursor: string | null = ''
    let pages = 0
    while (cursor !== null) {
      cursor = await schedulePage(
        getDb(t.env.DB),
        cursor,
        async (userId) => {
          enqueued.push(userId)
        },
        2,
      )
      pages += 1
    }
    const expected = users.filter((_, index) => index !== 2).toSorted()
    expect(enqueued).toEqual(expected)
    expect(pages).toBe(3)
  })
})
