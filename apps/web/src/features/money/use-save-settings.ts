import type { Settings } from '@folio/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { settingsQuery } from './queries'

/** Saves settings, showing the change at once and rolling back if the save fails. */
export function useSaveSettings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (settings: Settings) =>
      api<Settings>('/api/settings', { method: 'PUT', json: settings }),
    onMutate: async (settings) => {
      await client.cancelQueries({ queryKey: settingsQuery.queryKey })
      const previous = client.getQueryData(settingsQuery.queryKey)
      client.setQueryData(settingsQuery.queryKey, settings)
      return { previous }
    },
    onError: (_error, _settings, context) => {
      if (context?.previous) client.setQueryData(settingsQuery.queryKey, context.previous)
    },
  })
}
