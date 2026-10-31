import { Big } from 'big.js'

/** An integer amount in base units (wei, lamports, satoshis) as a decimal string. */
export function fromBaseUnits(raw: string | bigint | number, decimals: number): string {
  return new Big(raw.toString()).div(new Big(10).pow(decimals)).toFixed()
}

/** Any numeric value as a plain decimal string (no exponent), for `Position.amount`. */
export function toDecimal(value: string | number): string {
  return new Big(value).toFixed()
}
