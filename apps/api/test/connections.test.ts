import { manual } from '@folio/sources'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { getConnection, openConfig } from '../src/connections'
import { getDb } from '../src/db'
import { createTestApp } from './app'
import { fakeExchange } from './fake-source'

let t: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  t = await createTestApp({}, { sources: [manual, fakeExchange] })
})
afterEach(() => t.dispose())

const exchange = { apiKey: 'key-1234', apiSecret: 'very-secret-value' }

describe('sources', () => {
  test('lists every plugin with its form schema', async () => {
    const { headers } = await t.signIn()
    const res = await t.send('GET', '/api/sources', headers)
    const body = (await res.json()) as { id: string; configSchema: unknown }[]
    expect(body.map((source) => source.id)).toEqual(['manual', 'fake-exchange'])
    expect(body[1]?.configSchema).toMatchObject({
      properties: { apiSecret: { secret: true, title: 'API secret' } },
    })
  })
})

describe('connections', () => {
  test('creates, lists, updates and deletes', async () => {
    const { headers } = await t.signIn()
    const created = await t.send('POST', '/api/connections', headers, {
      sourceId: 'fake-exchange',
      config: exchange,
    })
    expect(created.status).toBe(201)
    const view = (await created.json()) as { id: string; label: string }
    expect(view).toMatchObject({
      label: 'Fake key-',
      config: { apiKey: 'key-1234' },
      secretsSet: ['apiSecret'],
      status: null,
    })

    const renamed = await t.send('PATCH', `/api/connections/${view.id}`, headers, {
      label: 'Main',
    })
    expect(await renamed.json()).toMatchObject({ label: 'Main', secretsSet: ['apiSecret'] })

    const list = await t.send('GET', '/api/connections', headers)
    expect(await list.json()).toMatchObject([{ id: view.id, label: 'Main' }])

    expect((await t.send('DELETE', `/api/connections/${view.id}`, headers)).status).toBe(204)
    expect(await (await t.send('GET', '/api/connections', headers)).json()).toEqual([])
  })

  test('never returns a secret value, and stores it sealed', async () => {
    const { headers } = await t.signIn()
    const created = await t.send('POST', '/api/connections', headers, {
      sourceId: 'fake-exchange',
      config: exchange,
    })
    const text = await created.text()
    expect(text).not.toContain(exchange.apiSecret)
    const listed = await (await t.send('GET', '/api/connections', headers)).text()
    expect(listed).not.toContain(exchange.apiSecret)

    const row = await t.env.DB.prepare('select config, secrets from connections').first<{
      config: string
      secrets: string
    }>()
    expect(row?.config).not.toContain(exchange.apiSecret)
    expect(row?.secrets).toMatch(/^v1\./)
    expect(row?.secrets).not.toContain(exchange.apiSecret)
  })

  test('keeps saved secrets when an update leaves them out', async () => {
    const { headers, user } = await t.signIn()
    const { id } = (await (
      await t.send('POST', '/api/connections', headers, {
        sourceId: 'fake-exchange',
        config: exchange,
      })
    ).json()) as { id: string }
    const before = await t.env.DB.prepare('select secrets from connections').first<{
      secrets: string
    }>()
    const res = await t.send('PATCH', `/api/connections/${id}`, headers, {
      config: { apiKey: 'key-5678' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ config: { apiKey: 'key-5678' } })
    const saved = await getConnection(getDb(t.env.DB), user.id, id)
    expect(await openConfig(saved!, t.env.ENCRYPTION_SECRET)).toEqual({
      apiKey: 'key-5678',
      apiSecret: exchange.apiSecret,
    })
    expect(saved?.secrets).not.toBe(before?.secrets)
  })

  test('rejects an invalid config and one the source refuses', async () => {
    const { headers } = await t.signIn()
    const missing = await t.send('POST', '/api/connections', headers, {
      sourceId: 'fake-exchange',
      config: { apiKey: 'key-1234' },
    })
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ error: 'invalid_config', field: 'apiSecret' })

    const refused = await t.send('POST', '/api/connections', headers, {
      sourceId: 'fake-exchange',
      config: { apiKey: 'bad', apiSecret: 'x' },
    })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ message: 'The key was refused' })

    const unknown = await t.send('POST', '/api/connections', headers, {
      sourceId: 'nope',
      config: {},
    })
    expect(unknown.status).toBe(404)
  })

  test("users can't see or change each other's connections", async () => {
    const alice = await t.signIn('Alice')
    const bob = await t.signIn('Bob')
    const { id } = (await (
      await t.send('POST', '/api/connections', alice.headers, {
        sourceId: 'manual',
        config: { holdings: [{ assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '1' }] },
      })
    ).json()) as { id: string }

    expect(await (await t.send('GET', '/api/connections', bob.headers)).json()).toEqual([])
    expect(
      (await t.send('PATCH', `/api/connections/${id}`, bob.headers, { label: 'x' })).status,
    ).toBe(404)
    expect((await t.send('DELETE', `/api/connections/${id}`, bob.headers)).status).toBe(404)
    expect(await (await t.send('GET', '/api/connections', alice.headers)).json()).toHaveLength(1)
  })

  test('manual connections work end to end', async () => {
    const { headers } = await t.signIn()
    const res = await t.send('POST', '/api/connections', headers, {
      sourceId: 'manual',
      label: 'Cold storage',
      config: {
        holdings: [{ assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '0.5', note: 'Ledger' }],
      },
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      label: 'Cold storage',
      secretsSet: [],
      config: { holdings: [{ amount: '0.5', note: 'Ledger' }] },
    })
  })
})
