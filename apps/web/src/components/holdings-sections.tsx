import {
  cn,
  LogoAvatar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  SharedLayoutBg,
  useHoverPopover,
} from "@folio/ui";
import { useTranslations } from "use-intl";
import type { DefiGroup, DefiRow } from "../lib/account-view";
import {
  defiMeaningfulLegs,
  defiSummary,
  groupLegsByRole,
  protocolDayChange,
} from "../lib/account-view";
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
          {/* 账户块之间分隔线(首块不加):虚线 + 上下留白拉开块间距。
              Separator 默认是 bg 实线 → 置透明底、改 border-dashed 画虚线。 */}
          {i > 0 && (
            <Separator className="mt-2 mb-5 h-0 border-border border-t border-dashed bg-transparent" />
          )}
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

// 负债腿的展示:「−」+ 中性色(不用亏损红 —— 负债≠亏损,红/绿只留给涨跌);角色由 chip/分组承载。
const legText = (r: DefiRow) =>
  `${r.usdValue < 0 ? "−" : ""}${formatNumber(Math.abs(r.amount))} ${r.symbol}`;

// 行内每腿的角色小标(B 方案):极小方角标签,capitalize;hover 行时底色翻 --background 不融进滑块。
function LegRole({ role }: { role?: string }) {
  if (!role) return null;
  return (
    <span className="ml-1 rounded bg-muted px-1 py-px align-middle text-[10px] text-muted-foreground capitalize transition-colors group-hover:bg-background">
      {role}
    </span>
  );
}

// 行内容:单个 flex 容器(SharedLayoutBg 接线,同上)。左簇(logo+名+摘要)是 hover 弹层触发器。
function DefiProtocolRowContent({ group }: { group: DefiGroup }) {
  const usd = useDisplayValue();
  const subtotal = group.rows.reduce((s, r) => s + r.usdValue, 0);
  const change = protocolDayChange(group.rows);
  // 行内:有值腿按值降序封顶 + 折 more,每腿贴角色 chip。弹层:全量有值腿按角色分组。
  const { legs, more } = defiSummary(group.rows);
  const roleGroups = groupLegsByRole(defiMeaningfulLegs(group.rows));
  const pop = useHoverPopover();
  return (
    <div className="flex w-full items-center gap-3">
      {/* 左簇即触发器:hover/focus 展开完整分组明细。协议 logo 数据管线未建(follow-up),首字母兜底。 */}
      <Popover
        trigger="hover"
        side={pop.side}
        onOpenChange={pop.onOpenChange}
        className={cn("min-w-0 flex-1", pop.rootClassName)}
      >
        <PopoverTrigger>
          <button
            ref={pop.measureRef}
            type="button"
            className="flex w-full min-w-0 items-center gap-3 text-left outline-none"
          >
            <LogoAvatar fallback={group.protocol} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{group.protocol}</div>
              {/* 头寸摘要(B):有值腿逐段 + 角色 chip;负债「−」中性色;超出封顶折 +n。 */}
              <div className="truncate text-muted-foreground text-xs tabular-nums">
                {legs.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && " · "}
                    {legText(r)}
                    <LegRole role={r.positionType} />
                  </span>
                ))}
                {more > 0 && <span className="text-muted-foreground/70"> +{more}</span>}
              </div>
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent>
          {/* 完整明细:按角色分段,组内全部有值腿 + 每腿美元值;负债「−」中性色;无净值行。 */}
          <div className="flex min-w-44 flex-col gap-0.5 p-1">
            <div className="mb-1 font-medium text-sm">{group.protocol}</div>
            {roleGroups.map((g) => (
              <div key={g.role ?? "_"}>
                {g.role && (
                  <div className="mt-1.5 text-muted-foreground text-xs uppercase tracking-wide">
                    {g.role}
                  </div>
                )}
                {g.legs.map((r) => (
                  <div key={r.id} className="flex justify-between gap-6 text-xs tabular-nums">
                    <span>{legText(r)}</span>
                    <span className="text-muted-foreground">
                      {r.usdValue < 0 ? "−" : ""}
                      {usd(Math.abs(r.usdValue))}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
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
