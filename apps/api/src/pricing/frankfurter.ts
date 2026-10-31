import { fetchJson } from '@folio/sources'
import { z } from 'zod'

const latestSchema = z.object({ rates: z.record(z.string(), z.number().positive()) })

/** Units of each fiat currency per 1 USD, from the ECB via Frankfurter (keyless). */
export async function fetchFiatRates(fetch: typeof globalThis.fetch): Promise<Map<string, number>> {
  const body = await fetchJson(
    fetch,
    'https://api.frankfurter.dev/v1/latest?base=USD',
    latestSchema,
  )
  return new Map([['USD', 1], ...Object.entries(body.rates)])
}
