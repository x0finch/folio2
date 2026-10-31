import { afterEach, beforeEach, expect, test } from 'vitest'

import { createTestApp } from './app'

let t: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  t = await createTestApp()
})
afterEach(() => t.dispose())

test('health touches D1 and needs no session', async () => {
  const res = await t.request('/api/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
