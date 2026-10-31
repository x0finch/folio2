import { expect, test } from 'vitest'

import { open, seal } from '../src/crypto'

const SECRET = 'test-encryption-secret-test-encryption'

test('round-trips values for the same context', async () => {
  const sealed = await seal(SECRET, { apiSecret: 's3cr3t' }, 'user-1/conn-1')
  expect(sealed).not.toContain('s3cr3t')
  expect(await open(SECRET, sealed, 'user-1/conn-1')).toEqual({ apiSecret: 's3cr3t' })
})

test('does not open under another context or key', async () => {
  const sealed = await seal(SECRET, { apiSecret: 's3cr3t' }, 'user-1/conn-1')
  await expect(open(SECRET, sealed, 'user-2/conn-1')).rejects.toMatchObject({
    name: 'OperationError',
  })
  await expect(open(`${SECRET}-other`, sealed, 'user-1/conn-1')).rejects.toMatchObject({
    name: 'OperationError',
  })
})

test('uses a fresh IV every time', async () => {
  const a = await seal(SECRET, { k: 'v' }, 'c')
  const b = await seal(SECRET, { k: 'v' }, 'c')
  expect(a).not.toBe(b)
})
