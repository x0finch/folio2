import {
  AnimatedBadge,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SharedLayoutBg,
} from "@folio/ui";
import { Check, Settings2 } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useHoverPopover } from "../lib/hooks/use-hover-popover";
import { usePortfolio } from "../lib/hooks/use-portfolio";
import { PortfolioPickerModal } from "./portfolio-picker-modal";

const rowClass =
  "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors";

// 全局 Portfolio 选择器(ADR 0033):住 _authed 布局层,主页 / 账户页 / Insights 共享。
// 落在页头标题上方的小 badge(eyebrow 位),**hover 浮出**弹层切换。**渐进式显示**:只有一个 Portfolio
// 时不渲染(和今天完全一样);≥2 才浮现。选中态在内存(usePortfolio,不持久化)。
export function PortfolioSelector() {
  const t = useTranslations("Portfolio");
  const { portfolios, selectedId, select } = usePortfolio();
  const pop = useHoverPopover();
  const [manageOpen, setManageOpen] = useState(false);

  // 渐进式显示:单个 Portfolio → 不显示选择器。
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
          {/* 小 badge(AnimatedBadge)作 eyebrow;无上下箭头。button 承载 hover/measure ref
              (AnimatedBadge 非 forwardRef,故包一层 button)。 */}
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
            {/* option list 用 SharedLayoutBg:hover 高亮由移动 pill 承载(与侧栏/账户列表一致)。
                每个 <button> 的内容须是单个 flex 容器(SharedLayoutBg 会把 children 塞进非 flex 的 z-10 div)。 */}
            <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-md bg-muted">
              {portfolios.map((p) => (
                <button key={p.id} type="button" className={rowClass} onClick={() => select(p.id)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        p.id === selectedId ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </span>
                </button>
              ))}
            </SharedLayoutBg>
            {/* 独立直线分隔(不挂在带圆角的按钮上 → 线两端不带圆角痕迹)。 */}
            <div className="my-1 border-border border-t" />
            {/* 管理:自成一个 SharedLayoutBg,保持同款 bg-muted 滑动 pill(改名/设默认/删除,ADR 0033)。 */}
            <SharedLayoutBg inset={0} pillClassName="rounded-md bg-muted">
              <button
                key="manage"
                type="button"
                className={cn(rowClass, "text-muted-foreground")}
                onClick={() => setManageOpen(true)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Settings2 className="size-4 shrink-0" />
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
