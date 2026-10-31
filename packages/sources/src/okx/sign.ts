import { hmacBase64 } from '../exchanges/hmac'

export interface OkxSignInput {
  /** ISO 8601 with milliseconds, the same value as the OK-ACCESS-TIMESTAMP header. */
  timestamp: string
  method: string
  /** Path plus query string, e.g. `/api/v5/account/balance?ccy=BTC`. */
  requestPath: string
  body?: string
}

/** Base64 HMAC-SHA256 of `timestamp + method + requestPath + body`, as OKX's docs specify. */
export const signOkx = (input: OkxSignInput, secret: string) =>
  hmacBase64(
    secret,
    `${input.timestamp}${input.method.toUpperCase()}${input.requestPath}${input.body ?? ''}`,
  )

/** The four OK-ACCESS-* headers of a signed request. */
export async function okxHeaders(
  input: OkxSignInput,
  credentials: { apiKey: string; apiSecret: string; passphrase: string },
): Promise<Record<string, string>> {
  return {
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-SIGN': await signOkx(input, credentials.apiSecret),
    'OK-ACCESS-TIMESTAMP': input.timestamp,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase,
  }
}
