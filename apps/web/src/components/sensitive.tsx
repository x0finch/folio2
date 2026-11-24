import { cn } from "@folio/ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";

// Blurs the real value while balance privacy is on; click reveals everything. Passes children
// through untouched when not blurred.

// em-relative: amounts range from xs to 5xl, so the blur must scale with font size.
const BLUR_RADIUS = "0.4em";
// Blur alone leaves large glyph edges legible; the same-color currentColor glow smears them.
const BLURRED: CSSProperties = {
  filter: `blur(${BLUR_RADIUS})`,
  textShadow: `0 0 ${BLUR_RADIUS} currentColor`,
};

export function Sensitive({ children, className }: { children: ReactNode; className?: string }) {
  const t = useTranslations("Common");
  const { hidden, reveal } = useBalancePrivacy();

  // Not hidden: zero-overhead passthrough.
  if (!hidden) return <>{children}</>;

  // Swallow the click so it doesn't trigger the element underneath (e.g. the hero total toggle).
  const onReveal = () => reveal();
  return (
    // biome-ignore lint/a11y/useSemanticElements: often nested inside an existing <button>/<a>, where a real <button> would be invalid
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
      {/* The real value is still in the DOM: hide it from screen readers. */}
      <span aria-hidden="true" className="inline-block" style={BLURRED}>
        {children}
      </span>
    </span>
  );
}
