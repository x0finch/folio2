import {
  DEFAULT_SETTINGS,
  type RatesResponse,
  type Settings,
  type DisplayCurrency,
} from '@folio/shared'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

import { api } from '../../lib/api'
import { type MoneyOptions, formatMoney } from '../../lib/format'

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => api<Settings>('/api/settings'),
  staleTime: 5 * 60_000,
})

export const ratesQuery = queryOptions({
  queryKey: ['rates'],
  queryFn: () => api<RatesResponse>('/api/rates'),
  staleTime: 5 * 60_000,
})

/**
 * Formats USD values in the user's display currency. Falls back to USD until the rate for
 * that currency is known.
 */
export function useMoney() {
  const { data: settings = DEFAULT_SETTINGS } = useQuery(settingsQuery)
  const { data: rates } = useQuery(ratesQuery)
  const rate = rates?.[settings.currency]
  const currency: DisplayCurrency = rate ? settings.currency : 'USD'
  const factor = rate ?? 1
  const format = useCallback(
    (valueUsd: number, options?: MoneyOptions) => formatMoney(valueUsd * factor, currency, options),
    [factor, currency],
  )
  /** A USD value in the display currency, as a number (for animated figures). */
  const convert = useCallback((valueUsd: number) => valueUsd * factor, [factor])
  return { format, convert, currency, settings }
}
