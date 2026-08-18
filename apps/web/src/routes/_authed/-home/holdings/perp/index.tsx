import { LogoAvatar, Separator, SharedLayoutBg } from "@folio/ui";
import { useTranslations } from "use-intl";
import { AccountName } from "../../../../../components/account-name";
import type { PerpPositionView, PerpView } from "../../../../../lib/core/account-view";
import { formatNumber, signedUsd } from "../../../../../lib/core/format-number";
import { useDisplayValue } from "../../../../../lib/hooks/use-display-value";
import { Stat } from "../../hero/stat";
import { ValueDelta } from "../value-delta";
import { LiqRing } from "./liq-ring";
import { liqRisk, pnlPct } from "./liq-risk";

// 永续持仓明细 v2(H5 #120):总览「永续」tab 与账户详情抽屉共用。
// 与代币行同语言 —— 行式(零表格/表头)、左「标识+标题」右 <ValueDelta>;
// 行内色语义唯一(rev5):红绿只表达盈亏,--warn/--neg 警报只在 LiqRing 上,
// 方向 pill 一律中性灰(方向是事实,不是评价)。

interface PlatformBadge {
  name: string;
  logo?: string;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// 中性灰 chip:方向 pill(`3x Long`)小号,不与标题争重量;
// 行 hover(SharedLayoutBg 滑块 = bg-muted)时底色换 --background,不与滑块融为一体。
function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-medium text-muted-foreground text-xs tabular-nums transition-colors group-hover:bg-background">
      {children}
    </span>
  );
}

// side 原文 capitalize(Long/Short 不翻译 —— 金融术语中性化是设计定稿)。
const sideLabel = (side: "long" | "short") => side.charAt(0).toUpperCase() + side.slice(1);

function PerpRowContent({ p }: { p: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const risk = liqRisk(p);
  return (
    <div className="flex w-full items-center gap-3">
      {/* 方向 badge 上;数量+币种 与 强平风险环 同一行水平对齐(环挂在数量行的父容器里)。 */}
      <div className="flex flex-col items-start gap-1">
        <NeutralChip>
          {p.leverage != null ? `${p.leverage}x ` : ""}
          {sideLabel(p.side)}
        </NeutralChip>
        <div className="flex items-center gap-2">
          <span className="font-medium tabular-nums">
            {formatNumber(Math.abs(p.size))} {p.coin}
          </span>
          {risk ? (
            <LiqRing risk={risk} position={p} />
          ) : (
            // 无强平价(如全仓部分场景)→ 环降级为 muted 开仓价文本。
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("entry")} {usd(p.entryPx)}
            </span>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1" />
      <ValueDelta value={p.positionValue} delta={p.unrealizedPnl} pct={pnlPct(p)} />
    </div>
  );
}

function PerpAccountBody({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { equity, positions } = view;
  const totalUpnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const marginRatio =
    equity && equity.accountValue > 0 ? equity.totalMarginUsed / equity.accountValue : null;
  return (
    <>
      {equity && (
        <div className="flex flex-wrap gap-x-10 gap-y-2 px-3">
          <Stat label={t("accountEquity")} value={usd(equity.accountValue)} />
          <Stat
            label={t("upnl")}
            value={signedUsd(usd, totalUpnl)}
            className={totalUpnl > 0 ? "text-pos" : totalUpnl < 0 ? "text-neg" : undefined}
          />
          {marginRatio != null && (
            <Stat label={t("marginRatio")} value={`${Math.round(marginRatio * 100)}%`} />
          )}
          <Stat label={t("withdrawable")} value={usd(equity.withdrawable)} />
          <Stat label={t("notional")} value={usd(equity.totalNtlPos)} />
          {equity.accountValue > 0 && (
            <Stat
              label={t("accountLeverage")}
              value={`${(equity.totalNtlPos / equity.accountValue).toFixed(2)}x`}
            />
          )}
        </div>
      )}
      {positions.length > 0 && (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {positions.map((p) => (
            <div key={p.coin} className="group rounded-xl px-3 py-3 has-[[data-state=open]]:z-20">
              <PerpRowContent p={p} />
            </div>
          ))}
        </SharedLayoutBg>
      )}
    </>
  );
}

// 永续分区(单账户,抽屉用):eyebrow 节头 + 权益条 + 仓位行。
// hideHeader:抽屉改 tab 后 tab 即标题,节头冗余。
export function PerpPositions({ view, hideHeader }: { view: PerpView; hideHeader?: boolean }) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      {!hideHeader && <SectionHeader title={t("perpSectionTitle")} />}
      <PerpAccountBody view={view} />
    </section>
  );
}

export interface PerpSectionItem {
  id: string;
  view: PerpView;
  platform?: PlatformBadge;
  accountLabel?: string;
}

// 永续分区(总览「永续」tab 用):每账户一个子块,按账户权益降序。
export function PerpPositionsList({ items }: { items: PerpSectionItem[] }) {
  const sorted = [...items].sort(
    (a, b) => (b.view.equity?.accountValue ?? 0) - (a.view.equity?.accountValue ?? 0),
  );
  return (
    <section className="flex flex-col gap-6">
      {sorted.map((it, i) => (
        <div key={it.id} className="flex flex-col gap-3">
          {i > 0 && (
            <Separator className="mt-2 mb-5 h-0 border-border border-t border-dashed bg-transparent" />
          )}
          <div className="flex items-center gap-2.5 px-3">
            {it.platform && (
              <LogoAvatar size="sm" src={it.platform.logo} fallback={it.platform.name} />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">
                {it.platform?.name ?? it.accountLabel}
              </div>
              {it.platform && it.accountLabel && (
                <AccountName name={it.accountLabel} className="text-muted-foreground text-xs" />
              )}
            </div>
          </div>
          <PerpAccountBody view={it.view} />
        </div>
      ))}
    </section>
  );
}
