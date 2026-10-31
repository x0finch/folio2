import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { connectionsQuery, sourcesQuery } from '../connections/queries'

/** Icon and label per connection id, for the small "held at" logos. */
export function useAccountIcons() {
  const { data: connections = [] } = useQuery(connectionsQuery)
  const { data: sources = [] } = useQuery(sourcesQuery)
  return useMemo(
    () =>
      new Map(
        connections.map((connection) => {
          const source = sources.find((candidate) => candidate.id === connection.sourceId)
          return [connection.id, { icon: source?.icon ?? null, label: connection.label }] as const
        }),
      ),
    [connections, sources],
  )
}
