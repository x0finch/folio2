import { expect, test } from 'vitest'

import { isKnownTicker, tickerAsset, tickerAssetId } from '../src/tickers'

test('maps exchange tickers to CoinGecko ids, any case', () => {
  expect(tickerAssetId('BTC')).toBe('coingecko:bitcoin')
  expect(tickerAssetId('usdt')).toBe('coingecko:tether')
  expect(tickerAssetId('MATIC')).toBe(tickerAssetId('POL'))
  expect(isKnownTicker('ldo')).toBe(true)
})

test('keeps unknown tickers in the cex namespace', () => {
  expect(tickerAssetId('ordi')).toBe('cex:ORDI')
  expect(tickerAsset('ordi')).toEqual({ id: 'cex:ORDI', symbol: 'ORDI' })
  expect(isKnownTicker('ORDI')).toBe(false)
})
