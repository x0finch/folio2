import { expect, test } from 'vitest'

import { timeAgo } from '../src/lib/time'

test('reads like a person would say it', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  expect(timeAgo(now - 10_000, now)).toBe('just now')
  expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago')
  expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2 hours ago')
  expect(timeAgo(now - 26 * 3_600_000, now)).toBe('yesterday')
})
