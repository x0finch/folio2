import type { Env } from './env'

/**
 * Base URLs of the public market-data APIs. Overridable through env vars so the end-to-end
 * tests can point them at a local stub; production uses the defaults.
 */
export interface Upstreams {
  defillama: string
  frankfurter: string
  coingecko: string
}

export const DEFAULT_UPSTREAMS: Upstreams = {
  defillama: 'https://coins.llama.fi',
  frankfurter: 'https://api.frankfurter.dev',
  coingecko: 'https://api.coingecko.com',
}

export function upstreams(
  env: Pick<Env, 'DEFILLAMA_URL' | 'FRANKFURTER_URL' | 'COINGECKO_URL'>,
): Upstreams {
  return {
    defillama: env.DEFILLAMA_URL || DEFAULT_UPSTREAMS.defillama,
    frankfurter: env.FRANKFURTER_URL || DEFAULT_UPSTREAMS.frankfurter,
    coingecko: env.COINGECKO_URL || DEFAULT_UPSTREAMS.coingecko,
  }
}
