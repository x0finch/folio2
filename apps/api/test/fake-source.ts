import { SourceError, defineSource, field, secret } from '@folio/sources'
import { z } from 'zod'

/** An exchange-like source with a secret, whose validate() rejects the key "bad". */
export const fakeExchange = defineSource({
  id: 'fake-exchange',
  kind: 'exchange',
  label: 'Fake exchange',
  description: 'For tests',
  config: z.object({
    apiKey: field({ title: 'API key' }),
    apiSecret: secret({ title: 'API secret' }),
  }),
  maxRequests: () => 0,
  defaultLabel: (config) => `Fake ${config.apiKey.slice(0, 4)}`,
  validate: async ({ config }) => {
    if (config.apiKey === 'bad') throw new SourceError('unauthorized', 'The key was refused')
  },
  fetchPositions: async () => [
    { asset: { id: 'coingecko:bitcoin', symbol: 'BTC' }, amount: '1', kind: 'spot' },
  ],
})
