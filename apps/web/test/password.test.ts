import { expect, test } from 'vitest'

import { derivePasswordKey } from '../src/features/auth/password'

test('derives the same 64-hex key for the same email, whatever its case', async () => {
  const a = await derivePasswordKey('Alice@Example.com ', 'correct horse', 1000)
  const b = await derivePasswordKey('alice@example.com', 'correct horse', 1000)
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(a).toBe(b)
})

test('differs per email and per password', async () => {
  const base = await derivePasswordKey('a@example.com', 'pw-one', 1000)
  expect(await derivePasswordKey('b@example.com', 'pw-one', 1000)).not.toBe(base)
  expect(await derivePasswordKey('a@example.com', 'pw-two', 1000)).not.toBe(base)
})
