/** An EVM chain the `evm` source reads. */
export interface EvmChain {
  /** DefiLlama's chain key: the `<chain>` of token asset ids and the position's location. */
  key: string
  chainId: number
  /** A keyless public JSON-RPC endpoint, used for the native balance. */
  rpc: string
  native: { coingeckoId: string; symbol: string; name: string }
}

const ETH = { coingeckoId: 'ethereum', symbol: 'ETH', name: 'Ethereum' }

/**
 * The chains read for every address: one `eth_getBalance` each, so this list is the request
 * budget. LI.FI reports tokens on more chains; those are dropped because they are not here.
 */
export const EVM_CHAINS: readonly EvmChain[] = [
  { key: 'ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', native: ETH },
  { key: 'arbitrum', chainId: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com', native: ETH },
  { key: 'base', chainId: 8453, rpc: 'https://base-rpc.publicnode.com', native: ETH },
  { key: 'optimism', chainId: 10, rpc: 'https://optimism-rpc.publicnode.com', native: ETH },
  {
    key: 'polygon',
    chainId: 137,
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    native: { coingeckoId: 'polygon-ecosystem-token', symbol: 'POL', name: 'Polygon' },
  },
  {
    key: 'bsc',
    chainId: 56,
    rpc: 'https://bsc-rpc.publicnode.com',
    native: { coingeckoId: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  },
  {
    key: 'avax',
    chainId: 43114,
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    native: { coingeckoId: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
  },
  {
    key: 'gnosis',
    chainId: 100,
    rpc: 'https://gnosis-rpc.publicnode.com',
    native: { coingeckoId: 'xdai', symbol: 'xDAI', name: 'xDAI' },
  },
  { key: 'linea', chainId: 59144, rpc: 'https://linea-rpc.publicnode.com', native: ETH },
  { key: 'scroll', chainId: 534352, rpc: 'https://scroll-rpc.publicnode.com', native: ETH },
  { key: 'zksync', chainId: 324, rpc: 'https://mainnet.era.zksync.io', native: ETH },
]
