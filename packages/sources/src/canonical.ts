import { coingeckoId } from './asset'

/**
 * Tokens that are the same asset on several chains, keyed by `<chain>:<address>`, mapped to
 * one id so holdings merge across chains. Only native issuances (Circle's USDC, Tether's USDT,
 * ...): bridged and wrapped variants keep their own identity.
 */
const CANONICAL: Record<string, string> = {
  // USDC (Circle)
  'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': coingeckoId('usd-coin'),
  'arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831': coingeckoId('usd-coin'),
  'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': coingeckoId('usd-coin'),
  'optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85': coingeckoId('usd-coin'),
  'polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': coingeckoId('usd-coin'),
  'avax:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': coingeckoId('usd-coin'),
  'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': coingeckoId('usd-coin'),
  // USDT (Tether)
  'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': coingeckoId('tether'),
  'arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': coingeckoId('tether'),
  'polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': coingeckoId('tether'),
  'bsc:0x55d398326f99059ff775485246999027b3197955': coingeckoId('tether'),
  'avax:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': coingeckoId('tether'),
  'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': coingeckoId('tether'),
  'solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': coingeckoId('tether'),
  // DAI (Maker), native on Ethereum
  'ethereum:0x6b175474e89094c44da98b954eedeac495271d0f': coingeckoId('dai'),
}

/** The id holdings merge under: the canonical id when known, else the id itself. */
export const canonicalAssetId = (assetId: string) => CANONICAL[assetId] ?? assetId
