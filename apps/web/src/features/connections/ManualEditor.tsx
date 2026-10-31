import type { AssetSearchResult, ManualHoldingInput } from '@folio/shared'
import { Input } from '@folio/ui/components/motion/input'
import { useQuery } from '@tanstack/react-query'
import { Plus, Search, X } from 'lucide-react'
import { useDeferredValue, useState } from 'react'

import { Avatar } from '../../components/Avatar'
import { api } from '../../lib/api'

const DECIMAL = /^\d+(\.\d+)?$/

/** Rows of asset + amount for the manual source, with a coin search to add rows. */
export function ManualEditor({
  holdings,
  onChange,
}: {
  holdings: ManualHoldingInput[]
  onChange: (holdings: ManualHoldingInput[]) => void
}) {
  const [searching, setSearching] = useState(holdings.length === 0)

  return (
    <div className="flex flex-col gap-3">
      {holdings.map((holding, index) => {
        const invalid = holding.amount !== '' && !DECIMAL.test(holding.amount.trim())
        return (
          <div key={holding.assetId} className="flex items-start gap-3">
            <Avatar src={holding.logo} label={holding.symbol} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <Input
                aria-label={`${holding.symbol} amount`}
                inputMode="decimal"
                placeholder={`Amount of ${holding.symbol}`}
                value={holding.amount}
                error={invalid ? 'Enter a number like 1.25' : undefined}
                onChange={(amount) =>
                  onChange(holdings.map((row, i) => (i === index ? { ...row, amount } : row)))
                }
                rightIcon={<span className="text-xs text-muted-foreground">{holding.symbol}</span>}
              />
            </div>
            <button
              type="button"
              aria-label={`Remove ${holding.symbol}`}
              onClick={() => onChange(holdings.filter((_, i) => i !== index))}
              className="mt-1.5 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )
      })}
      {searching ? (
        <AssetSearch
          onPick={(asset) => {
            // One row per asset: picking it again just closes the search.
            if (holdings.some((holding) => holding.assetId === asset.assetId)) {
              setSearching(false)
              return
            }
            onChange([
              ...holdings,
              {
                assetId: asset.assetId,
                symbol: asset.symbol,
                name: asset.name,
                logo: asset.logo ?? undefined,
                amount: '',
              },
            ])
            setSearching(false)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setSearching(true)}
          className="inline-flex items-center gap-2 self-start rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" /> Add an asset
        </button>
      )}
    </div>
  )
}

function AssetSearch({ onPick }: { onPick: (asset: AssetSearchResult) => void }) {
  const [text, setText] = useState('')
  const q = useDeferredValue(text.trim())
  const { data, isFetching } = useQuery({
    queryKey: ['asset-search', q],
    queryFn: () => api<AssetSearchResult[]>(`/api/assets/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    staleTime: 60 * 60_000,
  })
  return (
    <div>
      <Input
        aria-label="Search coins"
        placeholder="Search coins, e.g. Bitcoin"
        value={text}
        onChange={setText}
        leftIcon={<Search className="size-4" />}
      />
      {q.length >= 2 && (
        <ul className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border">
          {data?.map((asset) => (
            <li key={asset.assetId}>
              <button
                type="button"
                onClick={() => onPick(asset)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <Avatar src={asset.logo} label={asset.symbol} size="sm" />
                <span className="font-medium">{asset.symbol}</span>
                <span className="truncate text-muted-foreground">{asset.name}</span>
              </button>
            </li>
          ))}
          {data?.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No coins match.</li>
          )}
          {!data && isFetching && (
            <li className="px-3 py-2 text-sm text-muted-foreground">Searching…</li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Holdings ready to save, or a message saying what's missing. */
export function holdingsToSend(holdings: ManualHoldingInput[]) {
  if (!holdings.length) return { error: 'Add at least one asset.' } as const
  if (holdings.some((holding) => !DECIMAL.test(holding.amount.trim()))) {
    return { error: 'Every asset needs an amount.' } as const
  }
  return {
    holdings: holdings.map((holding) => ({ ...holding, amount: holding.amount.trim() })),
  } as const
}
