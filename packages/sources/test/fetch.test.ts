import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { SourceError, budgetedFetch, fetchJson } from '../src'
import { fixtureFetch } from '../src/testing'

describe('budgetedFetch', () => {
  test('counts requests and refuses past the limit', async () => {
    const { fetch } = fixtureFetch([{ url: 'example.com', json: {} }])
    const budgeted = budgetedFetch(fetch, 2)
    await budgeted('https://example.com/a')
    await budgeted('https://example.com/b')
    expect(budgeted.budget.used).toBe(2)
    await expect(budgeted('https://example.com/c')).rejects.toMatchObject({ code: 'budget' })
    expect(budgeted.budget.used).toBe(2)
  })
})

describe('fetchJson', () => {
  const schema = z.object({ ok: z.boolean() })

  test('returns parsed JSON', async () => {
    const { fetch } = fixtureFetch([{ url: 'example.com', json: { ok: true, extra: 1 } }])
    expect(await fetchJson(fetch, 'https://example.com', schema)).toEqual({ ok: true })
  })

  test.each([
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'upstream'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetch } = fixtureFetch([{ url: 'example.com', status, json: {} }])
    const error = await fetchJson(fetch, 'https://example.com', schema).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({ code })
  })

  test('sends a User-Agent and asks for JSON', async () => {
    const { fetch, requests } = fixtureFetch([{ url: 'example.com', json: { ok: true } }])
    await fetchJson(fetch, 'https://example.com', schema)
    expect(requests[0]?.headers.get('user-agent')).toMatch(/^Folio\//)
    expect(requests[0]?.headers.get('accept')).toBe('application/json')
  })

  test('rejects an unexpected shape as an upstream error', async () => {
    const { fetch } = fixtureFetch([{ url: 'example.com', json: { ok: 'yes' } }])
    await expect(fetchJson(fetch, 'https://example.com', schema)).rejects.toMatchObject({
      code: 'upstream',
    })
  })

  test('transient codes are the ones worth retrying', () => {
    expect(new SourceError('rate_limited', '').transient).toBe(true)
    expect(new SourceError('unauthorized', '').transient).toBe(false)
  })
})
