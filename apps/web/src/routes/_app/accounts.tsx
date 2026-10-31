import type { Holding } from '@folio/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, Wallet } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '../../components/PageHeader'
import { ConnectionDialog, type DialogState } from '../../features/connections/ConnectionDialog'
import { ConnectionRow } from '../../features/connections/ConnectionRow'
import {
  connectionsQuery,
  portfolioQuery,
  sourcesQuery,
  syncQuery,
} from '../../features/connections/queries'
import { useMoney } from '../../features/money/queries'
import { SyncPill } from '../../features/sync/SyncPill'
import { useNow } from '../../lib/use-now'

export const Route = createFileRoute('/_app/accounts')({ component: AccountsPage })

function AccountsPage() {
  const [dialog, setDialog] = useState<DialogState>(null)
  const { data: connections, isPending } = useQuery(connectionsQuery)
  const { data: sources = [] } = useQuery(sourcesQuery)
  const { data: portfolio } = useQuery(portfolioQuery)
  const { data: sync } = useQuery(syncQuery)
  const { format } = useMoney()
  const now = useNow(30_000)

  // Per connection: its holdings and the value of its share of them.
  const byConnection = new Map<string, { holdings: Holding[]; valueUsd: number | null }>()
  for (const holding of portfolio?.holdings ?? []) {
    for (const part of holding.sources) {
      const entry = byConnection.get(part.connectionId) ?? { holdings: [], valueUsd: null }
      entry.holdings.push(holding)
      if (part.valueUsd !== null) entry.valueUsd = (entry.valueUsd ?? 0) + part.valueUsd
      byConnection.set(part.connectionId, entry)
    }
  }
  for (const perp of portfolio?.perps ?? []) {
    const entry = byConnection.get(perp.connectionId) ?? { holdings: [], valueUsd: null }
    entry.valueUsd = (entry.valueUsd ?? 0) + perp.equityUsd
    byConnection.set(perp.connectionId, entry)
  }
  const queued = new Set(sync?.queued ?? [])

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Manage your data sources"
        actions={
          <>
            <SyncPill />
            <button
              type="button"
              aria-label="Add account"
              onClick={() => setDialog({ view: 'pick' })}
              className="grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-accent"
            >
              <Plus className="size-4" />
            </button>
          </>
        }
      />
      {isPending ? (
        <ul className="flex flex-col gap-3" aria-busy>
          {[0, 1, 2].map((key) => (
            <li key={key} className="h-16 animate-pulse rounded-2xl bg-card" />
          ))}
        </ul>
      ) : connections?.length ? (
        <>
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">
            {connections.length} {connections.length === 1 ? 'account' : 'accounts'}
          </h2>
          <ul className="flex flex-col">
            {connections.map((connection) => {
              const entry = byConnection.get(connection.id)
              return (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  source={sources.find((source) => source.id === connection.sourceId)}
                  holdings={(entry?.holdings ?? []).toSorted(
                    (a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0),
                  )}
                  valueUsd={entry?.valueUsd ?? null}
                  syncing={queued.has(connection.id)}
                  now={now}
                  formatMoney={format}
                  onOpen={() => setDialog({ view: 'edit', connection })}
                />
              )
            })}
          </ul>
        </>
      ) : (
        <EmptyState onAdd={() => setDialog({ view: 'pick' })} />
      )}
      <ConnectionDialog state={dialog} onState={setDialog} />
    </>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-border-strong px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted">
        <Wallet className="size-5" />
      </span>
      <h2 className="mt-4 text-lg font-medium">No accounts yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Add a wallet address, an exchange API key or holdings by hand. Folio only reads balances.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
      >
        <Plus className="size-4" /> Add your first account
      </button>
    </div>
  )
}
