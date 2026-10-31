import { coingeckoId, type AssetRef } from './asset'

/**
 * Exchange tickers mapped to CoinGecko ids, so a coin held on an exchange merges with the same
 * coin held on chain. Every id here was checked against DefiLlama
 * (`coins.llama.fi/prices/current/coingecko:<id>`). Only tickers that mean the same coin on
 * every major venue belong here; anything else stays a `cex:<TICKER>` asset priced by the venue.
 */
const TICKERS: Record<string, string> = {
  AAVE: 'aave',
  ADA: 'cardano',
  ALGO: 'algorand',
  APT: 'aptos',
  ARB: 'arbitrum',
  ATOM: 'cosmos',
  AVAX: 'avalanche-2',
  AXS: 'axie-infinity',
  BCH: 'bitcoin-cash',
  BGB: 'bitget-token',
  BNB: 'binancecoin',
  BONK: 'bonk',
  BSV: 'bitcoin-cash-sv',
  BTC: 'bitcoin',
  CRO: 'crypto-com-chain',
  CRV: 'curve-dao-token',
  DAI: 'dai',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  ENA: 'ethena',
  ETC: 'ethereum-classic',
  ETH: 'ethereum',
  FDUSD: 'first-digital-usd',
  FET: 'fetch-ai',
  FIL: 'filecoin',
  HBAR: 'hedera-hashgraph',
  HYPE: 'hyperliquid',
  ICP: 'internet-computer',
  INJ: 'injective-protocol',
  JUP: 'jupiter-exchange-solana',
  KAS: 'kaspa',
  LDO: 'lido-dao',
  LINK: 'chainlink',
  LTC: 'litecoin',
  MANA: 'decentraland',
  MATIC: 'polygon-ecosystem-token',
  MKR: 'maker',
  MNT: 'mantle',
  NEAR: 'near',
  OKB: 'okb',
  ONDO: 'ondo-finance',
  OP: 'optimism',
  PEPE: 'pepe',
  POL: 'polygon-ecosystem-token',
  PYUSD: 'paypal-usd',
  RENDER: 'render-token',
  SAND: 'the-sandbox',
  SEI: 'sei-network',
  SHIB: 'shiba-inu',
  SOL: 'solana',
  STETH: 'staked-ether',
  STX: 'blockstack',
  SUI: 'sui',
  TAO: 'bittensor',
  TIA: 'celestia',
  TON: 'the-open-network',
  TRX: 'tron',
  TUSD: 'true-usd',
  UNI: 'uniswap',
  USD1: 'usd1-wlfi',
  USDC: 'usd-coin',
  USDE: 'ethena-usde',
  USDT: 'tether',
  VET: 'vechain',
  WBTC: 'wrapped-bitcoin',
  WIF: 'dogwifcoin',
  WLD: 'worldcoin-wld',
  XLM: 'stellar',
  XMR: 'monero',
  XRP: 'ripple',
}

/** Whether `symbol` (any case) maps to a CoinGecko id. */
export const isKnownTicker = (symbol: string) => symbol.toUpperCase() in TICKERS

/**
 * The asset id for an exchange ticker: `coingecko:<id>` for the coins above, else
 * `cex:<TICKER>`. Assets in the `cex` namespace have no feed price, so sources should report
 * the venue's `priceUsd` for them.
 */
export function tickerAssetId(symbol: string): string {
  const ticker = symbol.toUpperCase()
  const id = TICKERS[ticker]
  return id ? coingeckoId(id) : `cex:${ticker}`
}

/** The AssetRef for an exchange ticker. */
export const tickerAsset = (symbol: string): AssetRef => ({
  id: tickerAssetId(symbol),
  symbol: symbol.toUpperCase(),
})
