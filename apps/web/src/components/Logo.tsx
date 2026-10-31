import { APP_NAME } from '@folio/shared'

/** The wordmark: a folded page and the name. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className ?? ''}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden className="size-6 fill-foreground">
        <path d="M4 3h11l5 5v13H4z" opacity="0.25" />
        <path d="M4 3h11v5h5v4H9v9H4z" />
      </svg>
      <span className="text-lg lowercase">{APP_NAME}</span>
    </span>
  )
}
