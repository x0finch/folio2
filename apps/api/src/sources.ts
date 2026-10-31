import { type Source, sources } from '@folio/sources'

import type { SourceRegistry } from './types'

export function createRegistry(list: readonly Source[]): SourceRegistry {
  const byId = new Map(list.map((source) => [source.id, source]))
  return { all: list, get: (id) => byId.get(id) }
}

/** Every plugin in @folio/sources. */
export const defaultRegistry = createRegistry(sources)
