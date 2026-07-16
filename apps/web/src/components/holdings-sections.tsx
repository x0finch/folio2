import { LogoAvatar, Separator, SharedLayoutBg } from "@folio/ui";
import { useTranslations } from "use-intl";
import type { DefiGroup } from "../lib/account-view";
import { protocolDayChange } from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { liqRisk, type PerpPositionView, type PerpView, pnlPct } from "../lib/perp";
import { signedUsd } from "../lib/signed-usd";
import { AccountName } from "./account-name";
import { LiqRing } from "./liq-ring";
import { Stat } from "./stat";
import { ValueDelta } from "./value-delta";

// 永续 / DeFi 持仓明细 v2(H5 #120):总览「DeFi & Perps」tab 与账户详情抽屉共用。
// 与代币行同语言 —— 行式(零表格/表头)、左「标识+标题」右 <ValueDelta>;
// 行内色语义唯一(rev5):红绿只表达盈亏与负债,--warn/--neg 警报只在 LiqRing 上,
// 方向 pill 与类型 chip 一律中性灰(方向/类型是事实,不是评价)。

// 场馆展示元数据(PerpPositionsList 的账户子头用)。
export interface PlatformBadge {
  name: string;
  logo?: string;
}

// eyebrow 节头(仅抽屉用:spot/DeFi/perp 堆叠需分区名;总览 tab 即标题不渲染)。
function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// 中性灰 chip:方向 pill(`3x Long`)与 DeFi 类型 chip 共用形(小号,不与标题争重量;
// 字号走 token 刻度 text-xs,紧 padding 保持「小点」的定稿观感)。
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

// 行内容:单个 flex 容器(SharedLayoutBg 会把子元素内容塞进非 flex 的 z-10 div,同 token-holdings 接线)。
function PerpRowContent({ p }: { p: PerpPositionView }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const risk = liqRisk(p);
  return (
    <div className="flex w-full items-center gap-3">
      <NeutralChip>
        {p.leverage != null ? `${p.leverage}x ` : ""}
        {sideLabel(p.side)}
      </NeutralChip>
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
      <div className="min-w-0 flex-1" />
      {/* 右:当前名义价值 + uPnL(单前置符号,--pos/--neg)。 */}
      <ValueDelta value={p.positionValue} delta={p.unrealizedPnl} pct={pnlPct(p)} />
    </div>
  );
}

// 单账户的权益条 + 仓位行(无节头;PerpPositions / PerpPositionsList 共用)。
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
          {/* 账户级字段平铺(flex-wrap 窄容器自动换行):可提 / 名义敞口 / 账户真实杠杆。 */}
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
      {/* 无持仓 → 只显权益条,不加"无持仓"文案(权益条本身即完整状态)。 */}
      {positions.length > 0 && (
        // hover 高亮 = SharedLayoutBg 移动滑块(与代币行同语言,行间无分隔线);
        // 行必须是直接 DOM 子元素(组件元素收不到注入的 relative/onMouseEnter)。
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {positions.map((p) => (
            // 行内弹层打开时把整行抬到兄弟行之上(动态 side=bottom 时面板压得住下一行)。
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
// (总览 tab 用 PerpPositionsList,场馆子头自带 —— 此处不再有 platform/label 死参。)
export function PerpPositions({ view }: { view: PerpView }) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={t("perpSectionTitle")} />
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

// 永续分区(总览「永续」tab 用):每账户一个子块(场馆子头 + 权益条 + 仓位行),按账户权益
// 降序(大仓在前)。tab 本身即「永续」,不再有 eyebrow 节头,场馆子头就是块的身份。
export function PerpPositionsList({ items }: { items: PerpSectionItem[] }) {
  const sorted = [...items].sort(
    (a, b) => (b.view.equity?.accountValue ?? 0) - (a.view.equity?.accountValue ?? 0),
  );
  return (
    // 账户子块间距比块内(gap-3)大一档,块与块分得开。
    <section className="flex flex-col gap-6">
      {sorted.map((it, i) => (
        <div key={it.id} className="flex flex-col gap-3">
          {/* 账户块之间分隔线(首块不加)。 */}
          {i > 0 && <Separator />}
          {/* 场馆子头:logo 左跨两行,右侧 场馆名 / 账户名(带钱包图标,统一 <AccountName>)。 */}
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

// 类型 chip 上限:多类型协议(如借贷的 deposit+loan)最多显 2 个,余量折叠成 +n。
const MAX_TYPE_CHIPS = 2;

// 行内容:单个 flex 容器(SharedLayoutBg 接线,同上)。
function DefiProtocolRowContent({ group }: { group: DefiGroup }) {
  const subtotal = group.rows.reduce((s, r) => s + r.usdValue, 0);
  const change = protocolDayChange(group.rows);
  const types = [...new Set(group.rows.map((r) => r.positionType).filter((ty) => ty != null))];
  return (
    <div className="flex w-full items-center gap-3">
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
// hideHeader:总览已有独立「DeFi」tab,节头冗余;抽屉无 tab 上下文,保留标题。
export function DefiPositions({
  groups,
  hideHeader,
}: {
  groups: DefiGroup[];
  hideHeader?: boolean;
}) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      {!hideHeader && <SectionHeader title={t("defiSectionTitle")} />}
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {groups.map((g) => (
          <div key={g.protocol} className="group rounded-xl px-3 py-3">
            <DefiProtocolRowContent group={g} />
          </div>
        ))}
      </SharedLayoutBg>
    </section>
  );
}
