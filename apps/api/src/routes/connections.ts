import {
  type ConnectionView,
  type SourceInfo,
  createConnectionBody,
  updateConnectionBody,
} from '@folio/shared'
import { type Source, SourceError, budgetedFetch, describeSource } from '@folio/sources'
import { Hono } from 'hono'

import {
  deleteConnection,
  getConnection,
  insertConnection,
  listConnections,
  openConfig,
  toView,
  updateConnection,
} from '../connections'
import { getDb } from '../db'
import { fail, json } from '../http'
import { newId } from '../ids'
import { quietLog } from '../log'
import type { AppEnv } from '../types'

/** Parses a config for a source; fails the request with the first problem. */
function parseConfig(source: Source, config: unknown) {
  const parsed = source.config.safeParse(config)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    fail('invalid_config', {
      field: issue?.path.join('.') ?? null,
      message: issue?.message ?? 'Invalid config',
    })
  }
  return parsed.data
}

/** Asks the plugin whether the config works (checks the address, signs a test call). */
async function validateWithSource(source: Source, config: Record<string, unknown>) {
  if (!source.validate) return
  try {
    await source.validate({
      config,
      fetch: budgetedFetch(fetch, Math.max(1, source.maxRequests(config))),
      log: quietLog,
      now: new Date(),
    })
  } catch (error) {
    if (error instanceof SourceError)
      fail('invalid_config', { field: null, message: error.message })
    throw error
  }
}

export const sourceRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json<SourceInfo[]>(c.get('sources').all.map(describeSource)),
)

export const connectionRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await listConnections(getDb(c.env.DB), c.get('user').id)
    return c.json<ConnectionView[]>(
      rows.map((row) => toView(row, c.get('sources').get(row.sourceId))),
    )
  })
  .post('/', json(createConnectionBody), async (c) => {
    const body = c.req.valid('json')
    const source = c.get('sources').get(body.sourceId) ?? fail('not_found')
    const config = parseConfig(source, body.config)
    await validateWithSource(source, config)
    const row = await insertConnection(getDb(c.env.DB), c.env.ENCRYPTION_SECRET, {
      id: newId(),
      userId: c.get('user').id,
      source,
      label: body.label || source.defaultLabel(config),
      config,
    })
    if (!row) throw new Error('Insert returned no row')
    return c.json<ConnectionView>(toView(row, source), 201)
  })
  .patch('/:id', json(updateConnectionBody), async (c) => {
    const db = getDb(c.env.DB)
    const row = (await getConnection(db, c.get('user').id, c.req.param('id'))) ?? fail('not_found')
    const source = c.get('sources').get(row.sourceId) ?? fail('not_found')
    const body = c.req.valid('json')
    let config
    if (body.config) {
      // Secret fields left out keep their saved values.
      const saved = await openConfig(row, c.env.ENCRYPTION_SECRET)
      config = parseConfig(source, { ...saved, ...body.config })
      await validateWithSource(source, config)
    }
    const updated = await updateConnection(db, c.env.ENCRYPTION_SECRET, row, source, {
      label: body.label,
      config,
    })
    if (!updated) fail('not_found')
    return c.json<ConnectionView>(toView(updated, source))
  })
  .delete('/:id', async (c) => {
    const [deleted] = await deleteConnection(getDb(c.env.DB), c.get('user').id, c.req.param('id'))
    if (!deleted) fail('not_found')
    return c.body(null, 204)
  })
