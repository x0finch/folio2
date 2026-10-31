import { z } from 'zod'

import { defineSource } from '../define'
import { isDecimal } from '../position'

const holding = z.object({
  /** An asset id as in AssetRef (`coingecko:bitcoin`). */
  assetId: z.string().regex(/^[a-z0-9-]+:.+$/, 'Pick an asset'),
  symbol: z.string().trim().min(1).max(20),
  name: z.string().trim().max(80).optional(),
  logo: z.url().max(500).optional(),
  amount: z.string().trim().refine(isDecimal, 'Enter a number like 1.25'),
  /** Where it is kept, e.g. "Ledger" or "Bank". */
  note: z.string().trim().max(80).optional(),
})

export type ManualHolding = z.output<typeof holding>

/** Holdings entered by hand. The web app gives it its own editor instead of a generated form. */
export const manual = defineSource({
  id: 'manual',
  kind: 'manual',
  label: 'Manual',
  description: 'Assets you enter yourself: cold storage, other platforms, anything else',
  config: z.object({
    holdings: z.array(holding).max(200).meta({ title: 'Holdings' }),
  }),
  maxRequests: () => 0,
  defaultLabel: () => 'Manual',
  fetchPositions: async ({ config }) =>
    config.holdings.map((entry) => ({
      asset: { id: entry.assetId, symbol: entry.symbol, name: entry.name, logo: entry.logo },
      amount: entry.amount,
      kind: 'spot' as const,
      location: entry.note,
    })),
})
