import type { ReactNode } from "react";

// `eyebrow` is a small kicker slot above the title (the portfolio selector badge).
export function PageHeader({
  title,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      {/* select-none: header text is chrome, not content, so long-press shouldn't highlight it. */}
      <div className="min-w-0 select-none">
        {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
        <h1 className="font-semibold text-lg leading-tight">{title}</h1>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
