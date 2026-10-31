import type {
  ConnectionView,
  CreateConnectionBody,
  Portfolio,
  SourceInfo,
  SyncStatus,
  UpdateConnectionBody,
} from '@folio/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'

export const sourcesQuery = queryOptions({
  queryKey: ['sources'],
  queryFn: () => api<SourceInfo[]>('/api/sources'),
  staleTime: Infinity,
})

export const connectionsQuery = queryOptions({
  queryKey: ['connections'],
  queryFn: () => api<ConnectionView[]>('/api/connections'),
})

export const portfolioQuery = queryOptions({
  queryKey: ['portfolio'],
  queryFn: () => api<Portfolio>('/api/portfolio'),
})

/** Polls while a sync runs; idle otherwise. */
export const syncQuery = queryOptions({
  queryKey: ['sync'],
  queryFn: () => api<SyncStatus>('/api/sync'),
  refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
})

/** Everything a finished sync may have changed. */
export const SYNCED_DATA = [['connections'], ['portfolio'], ['rates'], ['history']] as const

export function useStartSync() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (connectionId?: string) =>
      api<SyncStatus>('/api/sync', { method: 'POST', json: { connectionId } }),
    onSuccess: (status) => client.setQueryData(syncQuery.queryKey, status),
  })
}

export function useCreateConnection() {
  const client = useQueryClient()
  const sync = useStartSync()
  return useMutation({
    mutationFn: (body: CreateConnectionBody) =>
      api<ConnectionView>('/api/connections', { method: 'POST', json: body }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: connectionsQuery.queryKey })
      // A new connection is fetched right away.
      sync.mutate(created.id)
    },
  })
}

export function useUpdateConnection(id: string) {
  const client = useQueryClient()
  const sync = useStartSync()
  return useMutation({
    mutationFn: (body: UpdateConnectionBody) =>
      api<ConnectionView>(`/api/connections/${id}`, { method: 'PATCH', json: body }),
    onSuccess: async (_, body) => {
      await client.invalidateQueries({ queryKey: connectionsQuery.queryKey })
      if (body.config) sync.mutate(id)
    },
  })
}

export function useDeleteConnection() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all(SYNCED_DATA.map((queryKey) => client.invalidateQueries({ queryKey })))
    },
  })
}
