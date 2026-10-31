import { asc, gt } from 'drizzle-orm'

import type { Db } from '../db'
import { connections } from '../db/schema'
import { SCHEDULER_PAGE_SIZE } from './constants'

/**
 * One page of the hourly sweep: the next users (by id, after `cursor`) that have connections,
 * each enqueued on their runner. Returns the cursor to continue from, or null when done.
 */
export async function schedulePage(
  db: Db,
  cursor: string,
  enqueue: (userId: string) => Promise<unknown>,
  pageSize = SCHEDULER_PAGE_SIZE,
): Promise<string | null> {
  const users = await db
    .selectDistinct({ userId: connections.userId })
    .from(connections)
    .where(gt(connections.userId, cursor))
    .orderBy(asc(connections.userId))
    .limit(pageSize)
  // One at a time: each call is a subrequest, and the runners need not start together.
  // oxlint-disable-next-line no-await-in-loop
  for (const { userId } of users) await enqueue(userId)
  return users.length === pageSize ? (users.at(-1)?.userId ?? null) : null
}
