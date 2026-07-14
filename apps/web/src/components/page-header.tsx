import type { ReactNode } from "react";

// v2 页头壳(H0 #98 → H2 #101):serif 大标题 + 副标题 + 右侧 actions 槽(同步入口)。
// 标题走 --font-serif(Newsreader,weight 400)—— 与设计一致;副标题灰、小号。
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
        <h1 className="font-serif font-normal text-3xl leading-tight tracking-tight sm:text-4xl">
          {title}
        </h1>
        {subtitle ? <p className="mt-1.5 text-muted-foreground text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
