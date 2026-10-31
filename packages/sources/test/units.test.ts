import { expect, test } from 'vitest'

import { fromBaseUnits, toDecimal } from '../src'

test('base units to decimal strings, exactly', () => {
  expect(fromBaseUnits('1234567890000000000', 18)).toBe('1.23456789')
  expect(fromBaseUnits(150000000n, 8)).toBe('1.5')
  expect(fromBaseUnits('1', 18)).toBe('0.000000000000000001')
  expect(fromBaseUnits('0', 6)).toBe('0')
})

test('numbers to plain decimals', () => {
  expect(toDecimal(1e-7)).toBe('0.0000001')
  expect(toDecimal('12.50')).toBe('12.5')
})
