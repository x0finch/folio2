import { type SyncStatus, startSyncBody } from '@folio/shared'
import { Hono } from 'hono'

import { getConnection } from '../connections'
import { getDb } from '../db'
import { fail, json } from '../http'
import type { AppEnv } from '../types'

const runnerFor = (env: AppEnv['Bindings'], userId: string) =>
  env.SYNC_RUNNER.get(env.SYNC_RUNNER.idFromName(userId))

export const syncRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const status = await runnerFor(c.env, c.get('user').id).status()
    return c.json<SyncStatus>(status)
  })
  .post('/', json(startSyncBody), async (c) => {
    const userId = c.get('user').id
    const { connectionId } = c.req.valid('json')
    if (connectionId && !(await getConnection(getDb(c.env.DB), userId, connectionId))) {
      fail('not_found')
    }
    const status = await runnerFor(c.env, userId).enqueue(
      userId,
      connectionId ? [connectionId] : undefined,
    )
    return c.json<SyncStatus>(status, 202)
  })
