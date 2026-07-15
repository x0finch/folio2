import { cn, LogoAvatar } from "@folio/ui";
import { useTranslations } from "use-intl";
import type { DefiGroup } from "../lib/account-view";
import { protocolDayChange } from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { liqRisk, type PerpPositionView, type PerpView, pnlPct } from "../lib/perp";
import { LiqRing } from "./liq-ring";
import { ValueDelta } from "./value-delta";

// 永续 / DeFi 持仓明细 v2(H5 #120):总览「DeFi & Perps」tab 与账户详情抽屉共用。
// 与代币行同语言 —— 行式(零表格/表头)、左「标识+标题」右 <ValueDelta>;
// 行内色语义唯一(rev5):红绿只表达盈亏与负债,--warn/--neg 警报只在 LiqRing 上,
// 方向 pill 与类型 chip 一律中性灰(方向/类型是事实,不是评价)。

// eyebrow 节头:小号大写 + 可选 muted 副标(总览 tab 上是账户名;抽屉单账户上下文不传)。
function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
      {sub && <span className="text-muted-foreground/70 text-xs">{sub}</span>}
    </div>
  );
}

// 中性灰 chip:方向 pill(`3x Long`)与 DeFi 类型 chip 共用形。
function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground text-xs tabular-nums">
      {children}
    </span>
  );
}

// 权益条单项(HeroStat 同款:muted xs label + mono 值)。
function EquityStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <div className="mb-0.5 text-muted-foreground text-xs">{label}</div>
      <div className={cn("font-mono font-semibold text-sm tabular-nums", className)}>{value}</div>
    </div>
  );
}

// side 原文 capitalize(Long/Short 不翻译 —— 金融术语中性化是设计定稿)。
const sideLabel = (side: "long" | "short") => side.charAt(0).toUpperCase() + side.slice(1);

function PerpRow({ p }: { p: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const risk = liqRisk(p);
  return (
    <div className="flex items-center gap-3 py-3">
      <NeutralChip>
        {p.leverage != null ? `${p.leverage}x ` : ""}
        {sideLabel(p.side)}
      </NeutralChip>
      <span className="font-medium tabular-nums">
        {formatNumber(Math.abs(p.size))} {p.coin}
      </span>
      {risk ? (
        <LiqRing position={p} />
      ) : (
        // 无强平价(如全仓部分场景)→ 环降级为 muted 开仓价文本。
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("entry")} {usd(p.entryPx)}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {/* 右:当前名义价值 + uPnL(单前置符号,--pos/--neg)。 */}
      <ValueDelta value={p.positionValue} delta={p.unrealizedPnl} pct={pnlPct(p)} />
    </div>
  );
}

// 永续分区:节头 + 权益条(权益 / Σ uPnL / 保证金占用%)+ 仓位行。
export function PerpPositions({ view, accountLabel }: { view: PerpView; accountLabel?: string }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { equity, positions } = view;
  const totalUpnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const marginRatio =
    equity && equity.accountValue > 0 ? equity.totalMarginUsed / equity.accountValue : null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={t("perpSectionTitle")} sub={accountLabel} />
      {equity && (
        <div className="flex flex-wrap gap-x-10 gap-y-2">
          <EquityStat label={t("accountEquity")} value={usd(equity.accountValue)} />
          <EquityStat
            label={t("upnl")}
            value={`${totalUpnl > 0 ? "+" : totalUpnl < 0 ? "−" : ""}${usd(Math.abs(totalUpnl))}`}
            className={totalUpnl > 0 ? "text-pos" : totalUpnl < 0 ? "text-neg" : undefined}
          />
          {marginRatio != null && (
            <EquityStat label={t("marginRatio")} value={`${Math.round(marginRatio * 100)}%`} />
          )}
        </div>
      )}
      {positions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noOpenPositions")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {positions.map((p) => (
            <PerpRow key={p.coin} p={p} />
          ))}
        </div>
      )}
    </section>
  );
}

// 类型 chip 上限:多类型协议(如借贷的 deposit+loan)最多显 2 个,余量折叠成 +n。
const MAX_TYPE_CHIPS = 2;

function DefiProtocolRow({ group }: { group: DefiGroup }) {
  const subtotal = group.rows.reduce((s, r) => s + r.usdValue, 0);
  const change = protocolDayChange(group.rows);
  const types = [...new Set(group.rows.map((r) => r.positionType).filter((ty) => ty != null))];
  return (
    <div className="flex items-center gap-3 py-3">
      {/* 协议 logo 位:数据管线未建(follow-up issue),恒为首字母 fallback;管线落地原位换图。 */}
      <LogoAvatar fallback={group.protocol} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{group.protocol}</span>
          {types.slice(0, MAX_TYPE_CHIPS).map((ty) => (
            <NeutralChip key={ty}>
              <span className="capitalize">{ty}</span>
            </NeutralChip>
          ))}
          {types.length > MAX_TYPE_CHIPS && (
            <span className="shrink-0 text-muted-foreground text-xs">
              +{types.length - MAX_TYPE_CHIPS}
            </span>
          )}
        </div>
        {/* 头寸摘要:数量+币种逐段;负值段(负债/借出)--neg。 */}
        <div className="truncate text-muted-foreground text-xs tabular-nums">
          {group.rows.map((r, i) => (
            <span key={r.id}>
              {i > 0 && " · "}
              <span className={r.usdValue < 0 ? "text-neg" : undefined}>
                {formatNumber(Math.abs(r.amount))} {r.symbol}
              </span>
            </span>
          ))}
        </div>
      </div>
      {/* 右:协议净小计 + 24h 聚合增量(整协议缺 change24h → 只显小计)。 */}
      <ValueDelta value={subtotal} delta={change?.delta} pct={change?.pct} />
    </div>
  );
}

// DeFi 分区:每协议一行(总览传跨账户合并的 groups,抽屉传单账户 groups)。
export function DefiPositions({ groups }: { groups: DefiGroup[] }) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={t("defiSectionTitle")} />
      <div className="flex flex-col divide-y divide-border/60">
        {groups.map((g) => (
          <DefiProtocolRow key={g.protocol} group={g} />
        ))}
      </div>
    </section>
  );
}
