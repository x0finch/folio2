import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema'

export type Db = ReturnType<typeof getDb>

const instances = new WeakMap<D1Database, ReturnType<typeof create>>()
const create = (d1: D1Database) => drizzle(d1, { schema })

/** One Drizzle wrapper per D1 binding (per isolate). */
export function getDb(d1: D1Database) {
  let db = instances.get(d1)
  if (!db) {
    db = create(d1)
    instances.set(d1, db)
  }
  return db
}
