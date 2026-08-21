import { cn, LogoAvatar, Popover, PopoverContent, PopoverTrigger, SharedLayoutBg } from "@folio/ui";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import type { DefiGroup, DefiRow } from "@/lib/core/account-view";
import { defiMeaningfulLegs, groupLegsByRole } from "@/lib/core/account-view";
import { formatNumber } from "@/lib/core/format-number";
import { defiLogoUrl } from "@/lib/core/logo";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";

// DeFi 持仓明细 v2(H5 #120):总览「DeFi」tab 与账户详情抽屉共用。
// 与代币行同语言 —— 行式(零表格/表头)、左「标识+标题」右 <ValueDelta>;
// 行内色语义唯一(rev5):红绿只表达盈亏与负债,类型是事实不是评价。

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="text-muted-foreground text-xs uppercase tracking-widest">{title}</span>
    </div>
  );
}

// 负债腿的展示:「−」+ 中性色(不用亏损红 —— 负债≠亏损,红/绿只留给涨跌);角色由 chip/分组承载。
const legText = (r: DefiRow) =>
  `${r.usdValue < 0 ? "−" : ""}${formatNumber(Math.abs(r.amount))} ${r.symbol}`;

// 角色 → 图表色(CLAUDE.md 原则 11:数据可视化是唯一取色例外,仍只走 --chart-* token;
// --chart-1..5 是设计系统既有色板,非自定义)。/50 加透明度让色段不扎眼(与深色轨道相融、更柔)。
// 负债段不取色,走中性斜纹。
const CHART_BG = [
  "bg-chart-1/50",
  "bg-chart-2/50",
  "bg-chart-3/50",
  "bg-chart-4/50",
  "bg-chart-5/50",
] as const;

// 强语义「资产」角色固定色(deposit/supply 及同义词 → 恒定 chart-1);负债(borrow/loan)已走斜纹、不进这里。
// 固定色位从 hash 池排除,保证固定角色永不与 hash 角色撞色。
const FIXED_ROLE_IDX: Record<string, number> = {
  deposit: 0,
  supply: 0,
  supplied: 0,
};
const RESERVED_IDX = new Set(Object.values(FIXED_ROLE_IDX));
const HASH_POOL = CHART_BG.map((_, i) => i).filter((i) => !RESERVED_IDX.has(i));

// 角色名 → 图表色索引:固定角色取固定色,其余 hash(role) % 池(djb2-lite)。同一角色名跨协议**恒定同色**
// (便于扫读);代价:同协议内两个 hash 角色可能撞色(角色数通常 1–3,概率低;固定角色已排除撞色)。
function roleColorIdx(role: string): number {
  const key = role.toLowerCase();
  const fixed = FIXED_ROLE_IDX[key];
  if (fixed != null) return fixed;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return HASH_POOL[Math.abs(h) % HASH_POOL.length];
}

// 负债段:中性色底 + 细斜纹(token-only;负债≠亏损,不用 --neg,靠纹理与资产色段区分)。
const DEBT_SEG_STYLE: React.CSSProperties = {
  backgroundColor: "var(--muted-foreground)",
  backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, var(--background) 3px 4px)",
};

interface RoleSeg {
  role?: string;
  legs: DefiRow[];
  gross: number; // 段宽 = 该角色毛敞口 Σ|usd|
  debt: boolean; // 该角色净为负 → 负债
  colorIdx: number | null; // 图表色索引;负债为 null
}

// 有值腿按角色分组 → 构成条的段。角色净负 = 负债(不取色);其余按 hash(role) 取图表色。
function toRoleSegs(rows: DefiRow[]): RoleSeg[] {
  return groupLegsByRole(defiMeaningfulLegs(rows)).map((g) => {
    const gross = g.legs.reduce((s, r) => s + Math.abs(r.usdValue), 0);
    const debt = g.legs.reduce((s, r) => s + r.usdValue, 0) < 0;
    return {
      role: g.role,
      legs: g.legs,
      gross,
      debt,
      colorIdx: debt ? null : roleColorIdx(g.role ?? ""),
    };
  });
}

// 段显示权重(%,和恒为 100 → flexGrow 相对分配即百分比):占比 < MIN% 的小段抬到 MIN%(让小仓/小角色
// 能被感知,不被压成看不见的一线),其余段按毛敞口瓜分剩余空间。标签与色段用同一权重 → 保持对齐。
const DEFI_BAR_MIN_SEG_PCT = 5;

function displayWeights(segs: RoleSeg[]): number[] {
  const n = segs.length;
  if (n === 0) return [];
  const total = segs.reduce((s, x) => s + x.gross, 0);
  if (total <= 0) return segs.map(() => 100 / n); // 全 0 值 → 均分
  const MIN = DEFI_BAR_MIN_SEG_PCT;
  const small = segs.map((s) => (s.gross / total) * 100 < MIN);
  const reserved = small.filter(Boolean).length * MIN;
  const largeTotal = segs.reduce((s, x, i) => (small[i] ? s : s + x.gross), 0);
  const remaining = Math.max(0, 100 - reserved);
  // largeTotal===0 仅当全部为小段 → 都取 MIN(flexGrow 相对分配即均分)。
  return segs.map((s, i) =>
    small[i] || largeTotal <= 0 ? MIN : (s.gross / largeTotal) * remaining,
  );
}

// 构成条(H5 #120 定稿,C 方案):协议名下一条 4px 细条,按角色分段(段宽 = 毛敞口占比),
// 角色名排条上方、按段宽对齐,写不下则整条隐藏(opacity:0 占位留白,与色段保持对齐)。整块是
// hover 触发器 → 弹按角色分组的全量明细(方向自适应 / 抬 z / 隐垫底取自 useHoverPopover,与风险环/笔记同款)。
function CompositionBar({ segs, label }: { segs: RoleSeg[]; label: string }) {
  const usd = useDisplayValue();
  const pop = useHoverPopover();
  const labelsRef = useRef<HTMLDivElement>(null);
  // 标签放不下(overflow → scrollWidth > clientWidth)整条隐藏;宽度变化(抽屉/响应式)经 ResizeObserver
  // 重算,数据变化(段宽)经 fitKey 依赖重跑 —— 段宽变化时容器总宽不变,ResizeObserver 不触发,故需 fitKey。
  const fitKey = segs.map((s) => `${s.role ?? ""}:${s.gross}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitKey 不在体内引用,但用于段宽变更后重测标签。
  useEffect(() => {
    const el = labelsRef.current;
    if (!el) return;
    const measure = () => {
      for (const lab of el.querySelectorAll<HTMLElement>("[data-lab]")) {
        lab.style.opacity = "";
        if (lab.clientWidth < lab.scrollWidth) lab.style.opacity = "0";
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitKey]);

  // 段宽权重(和为 100):小段抬到 5% 保可感知,其余按毛敞口瓜分。标签与色段共用 → 对齐;和为 100 也顺带
  // 解决「flex-grow 因子和 < 1 时不填满容器」(sub-dollar 协议)。
  const weights = displayWeights(segs);

  return (
    // pt 预留角色名的高度:角色名绝对定位在条上方、不占 root in-flow 盒 → root 顶 = 条顶。
    <div className="mt-1 ml-9 pt-4">
      <Popover
        trigger="hover"
        side={pop.side}
        align="start"
        onOpenChange={pop.onOpenChange}
        className={cn("w-full", pop.rootClassName)}
      >
        {/* 透明 hover 捕获层:把「角色名 + 条 + 条下方一小条」连成一整片 hover 区 —— 否则 root in-flow 盒
            只有 4px 的条,鼠标稍移到条下方就出判定区而关闭。absolute → 不影响 root 盒(锚点仍在条);
            **不带 aria-hidden**(否则会被 useHoverPopover 关闭态的 [&>[aria-hidden]]:hidden 隐藏,就捕获不到 hover)。 */}
        <div className="absolute inset-x-0 -top-4 -bottom-3.5" />
        {/* 角色名:绝对定位在条正上方,但仍是 Popover root 的 DOM 子级 —— hover 区照样覆盖它(beUI 的
            mouseenter 挂在 root 上,按 DOM 子树触发、不看几何盒);因不占 root in-flow 盒,root 顶 = 条顶,
            故面板几何 + goo pill 都以「条」为锚(上下都贴条),而非「标签+条」父块。写不下经 fit 隐藏。 */}
        <div ref={labelsRef} className="absolute bottom-full left-0 mb-0.5 flex w-full gap-0.5">
          {segs.map((s, i) => (
            <div
              key={s.role ?? `_${i}`}
              data-lab
              style={{ flexGrow: weights[i], flexBasis: 0 }}
              className="min-w-0 overflow-hidden whitespace-nowrap font-medium text-[10px] text-muted-foreground capitalize"
            >
              {s.role}
            </div>
          ))}
        </div>
        <PopoverTrigger>
          {/* 触发器只包 2px 条 → goo pill 只有条那么大、被条本身盖住(无黑块、退出 melt 自然)。 */}
          <button
            ref={pop.measureRef}
            type="button"
            aria-label={label}
            className="block w-full cursor-default outline-none"
          >
            {/* 4px 细条:按角色分段;负债段中性斜纹,其余取图表色。 */}
            <div className="flex h-1 gap-0.5 overflow-hidden rounded-full bg-muted">
              {segs.map((s, i) => (
                <div
                  key={s.role ?? `_${i}`}
                  style={{
                    flexGrow: weights[i],
                    flexBasis: 0,
                    ...(s.debt ? DEBT_SEG_STYLE : {}),
                  }}
                  className={cn("min-w-0", s.colorIdx != null && CHART_BG[s.colorIdx])}
                />
              ))}
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent>
          {/* 完整明细:按角色分段(段前色块对应条上色),组内全部有值腿 + 每腿美元值;负债「−」中性色。
              间隔三级节奏:组间 gap-2.5、组内(角色头↔腿、腿↔腿)gap-1;面板自带 p-4,不再叠 p-1。 */}
          <div className="flex min-w-52 flex-col gap-2.5">
            <div className="font-medium text-sm">{label}</div>
            {segs.map((s, i) => (
              <div key={s.role ?? `_${i}`} className="flex flex-col gap-1">
                {s.role && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <span
                      style={s.debt ? DEBT_SEG_STYLE : undefined}
                      className={cn(
                        "size-2 shrink-0 rounded-[2px]",
                        s.colorIdx != null && CHART_BG[s.colorIdx],
                      )}
                    />
                    {s.role}
                  </div>
                )}
                {s.legs.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-baseline justify-between gap-8 text-xs tabular-nums"
                  >
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
    </div>
  );
}

// DeFi 协议行:上行 logo+名 与右侧 <ValueDelta>;下方一条构成条(角色分段 + hover 全量明细)。
// hover 触发器只在构成条上(不再是整行左簇)—— 扫列表不再连炸弹层(H5 定稿)。
function DefiProtocolRowContent({
  group,
  gainPending,
}: {
  group: DefiGroup;
  gainPending: boolean;
}) {
  const subtotal = group.rows.reduce((s, r) => s + r.usdValue, 0);
  // 24h 盈亏(ADR 0040):server 算好的。DeFi 这类没有「几个币」可依,只能拿两张照片的价值相减 ——
  // 已知妥协,你动仓那天不准。百分比的分母是**总敞口**(不是净值),对冲仓才不会给出荒唐的数。
  const change = group.gain24h;
  const segs = toRoleSegs(group.rows);
  return (
    <div className="w-full">
      <div className="flex w-full items-center gap-3">
        {/* 协议 logo(#126):有图 → 经 /api/logo/defi 代理;无图 → 首字母兜底。 */}
        <LogoAvatar
          src={defiLogoUrl(group.protocol, group.protocolLogo)}
          fallback={group.protocol}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{group.protocol}</div>
        </div>
        {/* 右:协议净小计 + 24h 聚合增量。整协议一行都算不出 → `—`(不是留白:协议行本来就该有这个数)。
            还在取 → 小骨架,不跟破折号混。 */}
        <ValueDelta
          value={subtotal}
          delta={change?.amount ?? null}
          pct={change?.pct}
          loading={gainPending}
        />
      </div>
      <CompositionBar segs={segs} label={group.protocol} />
    </div>
  );
}

// DeFi 分区:每协议一行(总览传跨账户合并的 groups,抽屉传单账户 groups)。
// hideHeader:总览已有独立「DeFi」tab,节头冗余;抽屉无 tab 上下文,保留标题。
export function DefiPositions({
  groups,
  hideHeader,
  gainPending = false,
}: {
  groups: DefiGroup[];
  hideHeader?: boolean;
  /** 24h 盈亏还在取 —— 市值照常,增量位走小骨架。账户抽屉不传。 */
  gainPending?: boolean;
}) {
  const t = useTranslations("Overview");
  return (
    <section className="flex flex-col gap-3">
      {!hideHeader && <SectionHeader title={t("defiSectionTitle")} />}
      <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
        {groups.map((g) => (
          // 行内 popover 打开时把整行抬到兄弟行之上(否则被后续行盖住;与 perp 行同款)。
          <div
            key={g.protocol}
            className="group rounded-xl px-3 py-1.5 has-[[data-state=open]]:z-20"
          >
            <DefiProtocolRowContent group={g} gainPending={gainPending} />
          </div>
        ))}
      </SharedLayoutBg>
    </section>
  );
}
