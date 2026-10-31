import { binance } from './binance'
import { bybit } from './bybit'
import type { Source } from './define'
import { manual } from './manual'
import { okx } from './okx'

/**
 * Every source plugin. Adding a source: create `src/<id>/index.ts` with `defineSource()`, add
 * fixture tests next to it, and list it here.
 */
export const sources: readonly Source[] = [manual, binance, okx, bybit]

const byId = new Map(sources.map((source) => [source.id, source]))

export function getSource(id: string): Source | undefined {
  return byId.get(id)
}
