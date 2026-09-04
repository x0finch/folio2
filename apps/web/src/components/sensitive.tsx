import { cn } from "@folio/ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useBalancePrivacy } from "@/lib/privacy/context";

// 敏感值的遮罩(FOL-75,ADR 0052)。开着隐私且没临时显示时,把**真实值**高斯模糊掉;点一下 →
// 临时显示全部(点一处全显)。不遮时零包装、直接透传 children。
//
// 手搓的 token-only 本地原语(类比 Card/Skeleton):beUI/shadcn 都没有这类件。只做模糊 + 点击显示 +
// 对屏幕阅读器隐藏,不引入任何颜色/新样式。

// em 相对:金额字号从 xs 到 5xl 不等,固定 px 模糊在小字上糊过头、大字上糊不够 —— 跟着字号缩放。
const BLUR_RADIUS = "0.4em";
// text-shadow 兜底(ADR 0052):大字号下光靠 blur,字形边缘仍隐约可读;再叠一层 currentColor 的
// 同色光晕把字缝糊平,读不出数字。用 currentColor 而非写死颜色 —— 不违反「只引用 token」。
const BLURRED: CSSProperties = {
  filter: `blur(${BLUR_RADIUS})`,
  textShadow: `0 0 ${BLUR_RADIUS} currentColor`,
};

export function Sensitive({ children, className }: { children: ReactNode; className?: string }) {
  const t = useTranslations("Common");
  const { hidden, reveal } = useBalancePrivacy();

  // 不遮:零开销透传,DOM 里就是原样的值。
  if (!hidden) return <>{children}</>;

  // 遮:整块变成一个「点一下显示」的按钮。**吞掉点击**——别顺带触发底下元素(如 hero 点总额切缩写)。
  const onReveal = () => reveal();
  return (
    // biome-ignore lint/a11y/useSemanticElements: 常包在既有 <button>/<a> 内(如 hero 点总额切缩写),用真 <button> 会造成非法嵌套
    <span
      role="button"
      tabIndex={0}
      aria-label={t("balanceHidden")}
      onClick={(e) => {
        e.stopPropagation();
        onReveal();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onReveal();
        }
      }}
      className={cn("inline-flex cursor-pointer select-none", className)}
    >
      {/* 真实值仍在 DOM,只是视觉模糊 —— 对屏幕阅读器隐藏,别把真数字念出来。 */}
      <span aria-hidden="true" className="inline-block" style={BLURRED}>
        {children}
      </span>
    </span>
  );
}
