import { afterAll, beforeAll, expect, test } from 'vitest'

import { createApp } from '../src/app'
import type { Env } from '../src/env'
import { createTestDb } from './d1'

let db: Awaited<ReturnType<typeof createTestDb>>

beforeAll(async () => {
  db = await createTestDb()
})
afterAll(() => db.dispose())

test('health touches D1 and reports ok', async () => {
  const env: Env = { DB: db.db }
  const res = await createApp().request('/api/health', {}, env)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
