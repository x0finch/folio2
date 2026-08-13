import type { ReactNode } from "react";

// v2 页头壳(H0 #98 → H2 #101):serif 大标题 + 副标题 + 右侧 actions 槽(同步入口)。
// 标题走 --font-serif(Newsreader,weight 400)—— 与设计一致;副标题灰、小号。
// eyebrow:标题上方的小 kicker 槽(Portfolio 选择器 badge 落这里,ADR 0033)。
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      {/* select-none:页头标题与副标题是外壳,不是内容 —— 长按它们不该出现选中高亮(片3)。
          它们不是 button/nav,不在 base 层那组里,所以在这里单独标。 */}
      <div className="min-w-0 select-none">
        {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
        <h1 className="font-serif font-normal text-3xl leading-tight tracking-tight sm:text-4xl">
          {title}
        </h1>
        {subtitle ? <p className="mt-1.5 text-muted-foreground text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
