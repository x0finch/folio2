import { Big } from 'big.js'
import { z } from 'zod'

import { field, secret } from '../define'
import { toDecimal } from '../units'

/**
 * A number an exchange sends as a string, as a plain decimal string. Accepts exponent forms
 * (`1e-8`), which some venues send for dust.
 */
export const venueDecimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/)
  .transform((value) => toDecimal(value))

/** Like `venueDecimal`, but venues leave some numbers empty (`""`) when they don't apply. */
export const optionalVenueDecimal = z.union([z.literal(''), venueDecimal])

/** The API key field every exchange uses; the key itself is not a secret, the secret is. */
export const apiKeyField = () =>
  field({ title: 'API key', placeholder: 'Read-only API key' }).regex(
    /^[\w-]{8,128}$/,
    'Paste the API key exactly as the exchange shows it',
  )

export const apiSecretField = () =>
  secret({ title: 'API secret', placeholder: 'Shown once when you create the key' })

/** A short label for a connection: the venue and the key's last four characters. */
export const keyLabel = (venue: string, apiKey: string) => `${venue} …${apiKey.slice(-4)}`

/** The sum of decimal strings, as a decimal string. Empty strings count as zero. */
export const sumDecimals = (...values: string[]) =>
  values.reduce((sum, value) => sum.plus(value === '' ? 0 : value), new Big(0)).toFixed()

/** A venue price for `amount` worth `usd`, or undefined when either is zero or unknown. */
export function unitPrice(usd: string, amount: string): number | undefined {
  if (usd === '' || amount === '') return undefined
  const units = new Big(amount)
  if (units.eq(0)) return undefined
  const price = new Big(usd).div(units).abs().toNumber()
  return price > 0 ? price : undefined
}
