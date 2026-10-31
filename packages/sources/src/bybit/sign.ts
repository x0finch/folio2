import { hmacHex } from '../exchanges/hmac'

/** How long a signed request stays valid on Bybit's side, in ms. */
export const RECV_WINDOW = 10_000

export interface BybitSignInput {
  /** Milliseconds since the epoch, the same value as the X-BAPI-TIMESTAMP header. */
  timestamp: number
  apiKey: string
  recvWindow: number
  /** The query string for GET requests, the JSON body for POST requests. */
  payload: string
}

/** Hex HMAC-SHA256 of `timestamp + apiKey + recvWindow + payload`, as Bybit's v5 docs specify. */
export const signBybit = (input: BybitSignInput, secret: string) =>
  hmacHex(secret, `${input.timestamp}${input.apiKey}${input.recvWindow}${input.payload}`)

/** The X-BAPI-* headers of a signed GET request with `query`. */
export async function bybitHeaders(
  query: string,
  timestamp: number,
  credentials: { apiKey: string; apiSecret: string },
): Promise<Record<string, string>> {
  const input = { timestamp, apiKey: credentials.apiKey, recvWindow: RECV_WINDOW, payload: query }
  return {
    'X-BAPI-API-KEY': credentials.apiKey,
    'X-BAPI-TIMESTAMP': String(timestamp),
    'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
    'X-BAPI-SIGN': await signBybit(input, credentials.apiSecret),
  }
}
