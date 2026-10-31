import { describe, expect, test } from 'vitest'

import { formatAmount, formatMoney, formatPercent } from '../src/lib/format'

describe('formatMoney', () => {
  test('fiat with two decimals', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50')
    expect(formatMoney(1234.5, 'EUR')).toBe('€1,234.50')
  })

  test('negative and signed values', () => {
    expect(formatMoney(-12.3, 'USD')).toBe('-$12.30')
    expect(formatMoney(12.3, 'USD', { signed: true })).toBe('+$12.30')
    expect(formatMoney(0, 'USD', { signed: true })).toBe('$0.00')
  })

  test('compact shortens only large values', () => {
    expect(formatMoney(1_234_567, 'USD', { compact: true })).toBe('$1.23M')
    expect(formatMoney(950, 'USD', { compact: true })).toBe('$950.00')
  })

  test('sub-cent prices keep three significant figures', () => {
    expect(formatMoney(0.000012345, 'USD')).toBe('$0.0000123')
    expect(formatMoney(0.5, 'USD')).toBe('$0.50')
  })

  test('BTC and ETH denominations', () => {
    expect(formatMoney(0.12345678, 'BTC')).toBe('₿0.123457')
    expect(formatMoney(-1.5, 'ETH', { signed: true })).toBe('-Ξ1.50')
    expect(formatMoney(2.25, 'ETH', { signed: true })).toBe('+Ξ2.25')
  })
})

describe('formatPercent', () => {
  test('two decimals, optional sign', () => {
    expect(formatPercent(0.1234)).toBe('12.34%')
    expect(formatPercent(-0.05, { signed: true })).toBe('-5.00%')
    expect(formatPercent(0.05, { signed: true })).toBe('+5.00%')
  })
})

describe('formatAmount', () => {
  test('precision follows magnitude', () => {
    expect(formatAmount('0')).toBe('0')
    expect(formatAmount('0.000123456')).toBe('0.000123')
    expect(formatAmount('12.3456789')).toBe('12.3457')
    expect(formatAmount('123456.789')).toBe('123,456.79')
  })

  test('passes through what is not a number', () => {
    expect(formatAmount('abc')).toBe('abc')
  })
})
