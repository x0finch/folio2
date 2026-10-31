import { base64, hex } from '@scure/base'

const encoder = new TextEncoder()

/** HMAC-SHA256 of `message` keyed by `secret`, with Web Crypto (available on Workers). */
async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

/** HMAC-SHA256 as a lowercase hex string (Binance, Bybit). */
export const hmacHex = async (secret: string, message: string) =>
  hex.encode(await hmacSha256(secret, message))

/** HMAC-SHA256 as a base64 string (OKX). */
export const hmacBase64 = async (secret: string, message: string) =>
  base64.encode(await hmacSha256(secret, message))
