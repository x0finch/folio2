import type { ReactNode } from "react";

// v2 页头壳(H0 #98):标题 + 副标题 + 右侧 actions 槽。
// serif 标题在 H2(#101)接入 --font-serif;副标题/同步入口等由后续切片填 actions。
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-muted-foreground text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
