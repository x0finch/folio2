import type { ConnectionView, ManualHoldingInput, SourceInfo } from '@folio/shared'
import { Button } from '@folio/ui/components/motion/button/base'
import { Input } from '@folio/ui/components/motion/input'
import { MorphingModal } from '@folio/ui/components/motion/morphing-modal'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, RefreshCw, Trash2, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import { ApiError } from '../../lib/api'
import { useWide } from '../../lib/use-media'
import { ConfigForm, type ConfigValues, configToSend } from './ConfigForm'
import { KINDS } from './kinds'
import { ManualEditor, holdingsToSend } from './ManualEditor'
import {
  sourcesQuery,
  useCreateConnection,
  useDeleteConnection,
  useStartSync,
  useUpdateConnection,
} from './queries'
import { formFields } from './schema-form'
import { SourceIcon } from './SourceIcon'

/** What the dialog shows: the source picker, a new connection's form, or an existing one. */
export type DialogState =
  | { view: 'pick' }
  | { view: 'new'; sourceId: string }
  | { view: 'edit'; connection: ConnectionView }
  | null

export function ConnectionDialog({
  state,
  onState,
}: {
  state: DialogState
  onState: (state: DialogState) => void
}) {
  const wide = useWide()
  const { data: sources = [] } = useQuery(sourcesQuery)
  const close = () => onState(null)
  const viewId =
    state === null
      ? null
      : state.view === 'pick'
        ? 'pick'
        : state.view === 'new'
          ? `new:${state.sourceId}`
          : `edit:${state.connection.id}`

  let content: ReactNode = null
  if (state?.view === 'pick') {
    content = (
      <Picker
        sources={sources}
        onClose={close}
        onPick={(sourceId) => onState({ view: 'new', sourceId })}
      />
    )
  } else if (state?.view === 'new') {
    const source = sources.find((candidate) => candidate.id === state.sourceId)
    if (source) {
      content = <NewForm source={source} onBack={() => onState({ view: 'pick' })} onDone={close} />
    }
  } else if (state?.view === 'edit') {
    const source = sources.find((candidate) => candidate.id === state.connection.sourceId)
    if (source) content = <EditForm source={source} connection={state.connection} onDone={close} />
  }

  return (
    <MorphingModal
      viewId={viewId}
      onClose={close}
      placement={wide ? 'center' : 'bottom'}
      className="max-w-md"
    >
      {content}
    </MorphingModal>
  )
}

function Header({
  title,
  subtitle,
  onBack,
  onClose,
  icon,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  onClose?: () => void
  icon?: ReactNode
}) {
  return (
    <div className="mb-5 flex items-start gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      )}
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-medium">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function Picker({
  sources,
  onPick,
  onClose,
}: {
  sources: SourceInfo[]
  onPick: (sourceId: string) => void
  onClose: () => void
}) {
  return (
    <div>
      <Header
        title="Add account"
        subtitle="Pick a source, then fill in its details."
        onClose={onClose}
      />
      <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
        {KINDS.map(({ kind, label }) => {
          const group = sources.filter((source) => source.kind === kind)
          if (!group.length) return null
          return (
            <section key={kind}>
              <h3 className="mb-2 text-xs text-muted-foreground">{label}</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {group.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => onPick(source.id)}
                    title={source.description}
                    className="flex flex-col items-start gap-2 rounded-xl border border-transparent p-3 text-left text-sm font-medium transition-colors hover:border-border hover:bg-card"
                  >
                    <SourceIcon source={source} size="sm" />
                    {source.label}
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** Turns an API error into a message, and a field to attach it to when the API names one. */
function describeError(error: unknown): { field?: string; message: string } {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_config') return { message: 'Check the details and try again.' }
  }
  return { message: 'Something went wrong. Try again.' }
}

function useFormState(initialLabel: string) {
  const [label, setLabel] = useState(initialLabel)
  const [values, setValues] = useState<ConfigValues>({})
  const [error, setError] = useState<string>()
  return { label, setLabel, values, setValues, error, setError }
}

/** A readable message for a failed save, naming the field when the API points at one. */
async function messageOf(error: unknown, source: SourceInfo): Promise<string> {
  if (error instanceof ApiError && error.detail?.message) {
    const field = formFields(source.configSchema).find((f) => f.name === error.detail?.field)
    return field ? `${field.title}: ${error.detail.message}` : error.detail.message
  }
  return describeError(error).message
}

function NewForm({
  source,
  onBack,
  onDone,
}: {
  source: SourceInfo
  onBack: () => void
  onDone: () => void
}) {
  const form = useFormState('')
  const [holdings, setHoldings] = useState<ManualHoldingInput[]>([])
  const create = useCreateConnection()

  async function submit(event: FormEvent) {
    event.preventDefault()
    form.setError(undefined)
    let config: Record<string, unknown>
    if (source.kind === 'manual') {
      const result = holdingsToSend(holdings)
      if ('error' in result) return form.setError(result.error)
      config = { holdings: result.holdings }
    } else config = configToSend(source, form.values)
    try {
      await create.mutateAsync({
        sourceId: source.id,
        label: form.label.trim() || undefined,
        config,
      })
      onDone()
    } catch (caught) {
      form.setError(await messageOf(caught, source))
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <Header title={source.label} subtitle={source.description} onBack={onBack} />
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-0.5">
        <Input
          label="Label (optional)"
          value={form.label}
          onChange={form.setLabel}
          placeholder={source.label}
        />
        {source.kind === 'manual' ? (
          <ManualEditor holdings={holdings} onChange={setHoldings} />
        ) : (
          <ConfigForm source={source} values={form.values} onChange={form.setValues} />
        )}
      </div>
      {form.error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {form.error}
        </p>
      )}
      <div className="mt-6 flex justify-end">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Checking…' : 'Add account'}
        </Button>
      </div>
    </form>
  )
}

function EditForm({
  source,
  connection,
  onDone,
}: {
  source: SourceInfo
  connection: ConnectionView
  onDone: () => void
}) {
  const form = useFormState(connection.label)
  const [holdings, setHoldings] = useState<ManualHoldingInput[]>(() =>
    source.kind === 'manual' ? savedHoldings(connection.config['holdings']) : [],
  )
  // Public fields start filled in; secrets start empty and keep their saved value if left so.
  const [values, setValues] = useState<ConfigValues>(() =>
    Object.fromEntries(
      Object.entries(connection.config).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const update = useUpdateConnection(connection.id)
  const remove = useDeleteConnection()
  const sync = useStartSync()

  async function submit(event: FormEvent) {
    event.preventDefault()
    form.setError(undefined)
    let config: Record<string, unknown>
    if (source.kind === 'manual') {
      const result = holdingsToSend(holdings)
      if ('error' in result) return form.setError(result.error)
      config = { holdings: result.holdings }
    } else config = configToSend(source, values)
    try {
      await update.mutateAsync({ label: form.label.trim() || connection.label, config })
      onDone()
    } catch (caught) {
      form.setError(await messageOf(caught, source))
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <Header
        title={connection.label}
        subtitle={source.label}
        icon={<SourceIcon source={source} />}
        onClose={onDone}
      />
      {connection.error && (
        <p className="mb-4 rounded-xl bg-loss-surface px-3 py-2 text-sm text-loss">
          Last sync failed: {connection.error.message}
        </p>
      )}
      <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto p-0.5">
        <Input label="Label" value={form.label} onChange={form.setLabel} />
        {source.kind === 'manual' ? (
          <ManualEditor holdings={holdings} onChange={setHoldings} />
        ) : (
          <ConfigForm
            source={source}
            values={values}
            onChange={setValues}
            savedSecrets={connection.secretsSet}
          />
        )}
      </div>
      {form.error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {form.error}
        </p>
      )}
      <div className="mt-6 flex items-center gap-2">
        {confirmDelete ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              onClick={() => void remove.mutateAsync(connection.id).then(onDone)}
              disabled={remove.isPending}
            >
              Delete for good
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Delete account"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Sync this account"
              onClick={() => {
                sync.mutate(connection.id)
                onDone()
              }}
            >
              <RefreshCw className="size-4" />
            </Button>
            <Button type="submit" className="ml-auto" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </div>
    </form>
  )
}

/** The manual source's saved rows, keeping only well-formed ones. */
function savedHoldings(value: unknown): ManualHoldingInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row: unknown): ManualHoldingInput[] => {
    if (typeof row !== 'object' || row === null) return []
    const field = (key: string): unknown => (key in row ? Reflect.get(row, key) : undefined)
    const [assetId, symbol, name, logo, amount, note] = [
      'assetId',
      'symbol',
      'name',
      'logo',
      'amount',
      'note',
    ].map(field)
    if (typeof assetId !== 'string' || typeof symbol !== 'string' || typeof amount !== 'string') {
      return []
    }
    return [
      {
        assetId,
        symbol,
        amount,
        name: typeof name === 'string' ? name : undefined,
        logo: typeof logo === 'string' ? logo : undefined,
        note: typeof note === 'string' ? note : undefined,
      },
    ]
  })
}
