import {
  AnimatedBadge,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SharedLayoutBg,
} from "@folio/ui";
import { Check, Settings2 } from "@folio/ui/icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { PortfolioPickerModal } from "./portfolio-picker-modal";

const rowClass =
  "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors";

// Shown only with 2+ portfolios; selection is in memory (usePortfolio), not persisted.
export function PortfolioSelector() {
  const t = useTranslations("Portfolio");
  const { portfolios, selectedId, select } = usePortfolio();
  const pop = useHoverPopover();
  const [manageOpen, setManageOpen] = useState(false);

  // Single portfolio: no selector.
  if (portfolios.length < 2) return null;

  const selected = portfolios.find((p) => p.id === selectedId);

  return (
    <>
      <Popover
        trigger="hover"
        side={"bottom"}
        align="start"
        panelRadius={12}
        onOpenChange={pop.onOpenChange}
        className={pop.rootClassName}
      >
        <PopoverTrigger>
          {/* AnimatedBadge isn't a forwardRef, so a button wraps it to carry hover/measure refs. */}
          <button
            ref={pop.measureRef}
            type="button"
            aria-label={t("selectorLabel")}
            className="rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <AnimatedBadge size="sm" showIcon={false} className="border-transparent">
              {selected?.name ?? t("selectorLabel")}
            </AnimatedBadge>
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="w-52">
            {/* SharedLayoutBg carries the hover pill; each button's content must be one flex container
                (it wraps children in a non-flex z-10 div). */}
            <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-md bg-muted">
              {portfolios.map((p) => (
                <button key={p.id} type="button" className={rowClass} onClick={() => select(p.id)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Check
                      className={cn(" shrink-0", p.id === selectedId ? "opacity-100" : "opacity-0")}
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </span>
                </button>
              ))}
            </SharedLayoutBg>
            {/* Standalone divider so the line ends carry no button rounding. */}
            <div className="my-1 border-border border-t" />
            {/* Manage: its own SharedLayoutBg to keep the same sliding pill. */}
            <SharedLayoutBg inset={0} pillClassName="rounded-md bg-muted">
              <button
                key="manage"
                type="button"
                className={cn(rowClass, "text-muted-foreground")}
                onClick={() => setManageOpen(true)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Settings2 className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t("manage")}</span>
                </span>
              </button>
            </SharedLayoutBg>
          </div>
        </PopoverContent>
      </Popover>
      <PortfolioPickerModal mode="manage" open={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  );
}
