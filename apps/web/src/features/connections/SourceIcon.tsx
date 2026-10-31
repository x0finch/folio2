import type { SourceInfo } from '@folio/shared'
import { PenLine } from 'lucide-react'

import { Avatar } from '../../components/Avatar'

export function SourceIcon({
  source,
  size = 'md',
}: {
  source: SourceInfo | undefined
  size?: 'sm' | 'md' | 'lg'
}) {
  if (source?.kind === 'manual') {
    const sizes = { sm: 'size-5', md: 'size-8', lg: 'size-10' }
    return (
      <span
        className={`grid shrink-0 place-items-center rounded-full bg-muted ${sizes[size]}`}
        aria-hidden
      >
        <PenLine className="size-1/2" />
      </span>
    )
  }
  return <Avatar src={source?.icon} label={source?.label ?? '?'} size={size} />
}
