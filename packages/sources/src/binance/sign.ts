import { hmacHex } from '../exchanges/hmac'

/** How long a signed request stays valid on Binance's side, in ms. */
export const RECV_WINDOW = 10_000

/**
 * The signed query string for a Binance USER_DATA request: `params` plus `recvWindow` and
 * `timestamp`, then `signature` = hex HMAC-SHA256 of everything before it, keyed by the secret.
 */
export async function signedQuery(
  params: Record<string, string>,
  secret: string,
  timestamp: number,
): Promise<string> {
  const query = new URLSearchParams({
    ...params,
    recvWindow: String(RECV_WINDOW),
    timestamp: String(timestamp),
  }).toString()
  return `${query}&signature=${await signBinance(query, secret)}`
}

/** Hex HMAC-SHA256 of the total params string, as Binance's request-security docs specify. */
export const signBinance = (totalParams: string, secret: string) => hmacHex(secret, totalParams)
