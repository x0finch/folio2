import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { usePortfolio } from "../lib/hooks/use-portfolio";

const menuItemClass =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted";

// 全局 Portfolio 选择器(ADR 0033):住 _authed 布局层,主页 / 账户页 / Insights 共享。
// **渐进式显示**:只有一个 Portfolio 时不渲染(和今天完全一样);≥2 才浮现。
// 选中态在内存(usePortfolio,不持久化);切换即让三页 scope 到选中的 Portfolio。
export function PortfolioSelector() {
  const t = useTranslations("Portfolio");
  const { portfolios, selectedId, select } = usePortfolio();
  const [open, setOpen] = useState(false);

  // 渐进式显示:单个 Portfolio → 不显示选择器。
  if (portfolios.length < 2) return null;

  const selected = portfolios.find((p) => p.id === selectedId);

  return (
    <div className="mb-5">
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="start"
        panelRadius={12}
        // 关闭态隐掉 goo 垫底的 aria-hidden 首元素(宽触发器 hover 会露黑块);打开时抬 z。
        className={cn(open ? "z-50" : "[&>[aria-hidden]]:hidden")}
      >
        <PopoverTrigger>
          <button
            type="button"
            aria-label={t("selectorLabel")}
            className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 font-medium text-sm transition-colors hover:bg-muted/70 dark:bg-background"
          >
            <span className="max-w-40 truncate">{selected?.name ?? t("selectorLabel")}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex w-52 flex-col gap-0.5">
            {portfolios.map((p) => (
              <button
                key={p.id}
                type="button"
                className={menuItemClass}
                onClick={() => {
                  select(p.id);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    p.id === selectedId ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
