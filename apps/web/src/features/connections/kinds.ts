import type { SourceKind } from '@folio/shared'

/** Order and names of source groups in the picker and the accounts list. */
export const KINDS: { kind: SourceKind; label: string }[] = [
  { kind: 'wallet', label: 'On-chain' },
  { kind: 'exchange', label: 'Exchanges' },
  { kind: 'perp', label: 'Perp DEX' },
  { kind: 'manual', label: 'Manual' },
]
