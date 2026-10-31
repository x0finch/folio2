import type { HistoryRange, HistoryResponse } from '@folio/shared'
import { queryOptions } from '@tanstack/react-query'

import { api } from '../../lib/api'

export const historyQuery = (range: HistoryRange) =>
  queryOptions({
    queryKey: ['history', 'portfolio', range],
    queryFn: () => api<HistoryResponse>(`/api/history?range=${range}`),
  })

export const assetHistoryQuery = (assetId: string, range: HistoryRange) =>
  queryOptions({
    queryKey: ['history', 'asset', assetId, range],
    queryFn: () =>
      api<HistoryResponse>(`/api/history/assets/${encodeURIComponent(assetId)}?range=${range}`),
  })
