import { expect, test } from 'vitest'

import { canonicalAssetId } from '../src'

test('native issuances on different chains merge; others stay as they are', () => {
  expect(canonicalAssetId('ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(
    'coingecko:usd-coin',
  )
  expect(canonicalAssetId('solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
    'coingecko:usd-coin',
  )
  // Bridged USDC.e on Arbitrum is a different asset.
  const bridged = 'arbitrum:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'
  expect(canonicalAssetId(bridged)).toBe(bridged)
})
