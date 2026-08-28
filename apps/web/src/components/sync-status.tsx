import type { ConnectorId } from "@folio/connectors";
import { cn, Popover, PopoverContent, PopoverTrigger, useHoverCapable } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { isRoundBusy, useSyncRound } from "@/lib/hooks/use-sync-round";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import type {
  SyncAttentionSource,
  SyncRoundFailure,
  SyncRoundView,
  SyncStatusSummary,
} from "@/lib/server/sync/status";
import { IconButton } from "./icon-button";

// 共享同步状态入口(PageHeader actions):**一个 Popover**,有鼠标就 hover 打开、触屏就 tap 打开,
// 两边包的是同一份 <SyncPanel>(状态徽章 + 本轮口径 + 上次更新 + 本轮失败 + 需要注意的来源
// + 独立同步按钮)。
//
// 移动端以前走 MorphingModal(从底部升起的卡片)。换掉它是因为那张卡的底行被悬浮 Dock 压住截断,
// 而 Dock 是固定的、卡片是居中的 —— 抬高只能是一个魔数在跟另一个魔数赛跑。锚在触发器下方的 popover
// 根本不到那一带,遮挡这件事随形态统一消失(FOL-32 裁定 2)。
//
// 全量同步的进度**长在这张面板里**,不再另发 toast(裁定 1):toast 与面板各有一套分母,同屏对不上。
// toast 只留给账户详情里的单账户同步 —— 那一处没有面板可长。
//
// **这一轮的一切都来自服务端**(ADR 0048):面板轮询读那一轮,不自己记账。所以 cron 跑的轮
// 在这里一样看得见,换页 / 换设备看到的也是同一件事。
//
// 分段按钮(beUI 胶囊):可选 action → 状态段右侧接「分隔线 + 自定义 icon 段」(如账户页的 + 添加账户)。
// 有 action 时状态段**不显旋转刷新图标**(进度走面板);无 action 时保持单枚 pill + 刷新图标。

export interface SyncAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

// 状态色调:同步中或有失败 → warn;否则 pos(与设计 syncStatusTone 一致)。
function tone(attention: boolean) {
  return attention
    ? { dot: "bg-warn", badge: "bg-warn-bg text-warn" }
    : { dot: "bg-pos", badge: "bg-pos-bg text-pos" };
}

interface StatusSegmentProps extends React.ComponentPropsWithoutRef<"button"> {
  label: string;
  dotClass: string;
  busy: boolean;
  showRefresh: boolean;
}

// 状态段:状态点 + 文案 +(可选)刷新图标。forwardRef + 透传 → 作 PopoverTrigger 的唯一子元素。
// 恒为一枚完整 beUI 胶囊(rounded-full + 边框 + 不透明 bg-card),尺寸/形状不随 action 变 —— 与 popover goo
// 半径对齐 → 无多余阴影;bg-card 亦作遮罩盖住其后的 + 段掖进部分。有 action 时仅隐去刷新图标(进度走面板)。
const StatusSegment = forwardRef<HTMLButtonElement, StatusSegmentProps>(function StatusSegment(
  { label, dotClass, busy, showRefresh, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3.5 font-mono text-foreground text-xs transition-colors hover:bg-muted",
        className,
      )}
      {...rest}
    >
      <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
      <span className="text-muted-foreground">{label}</span>
      {showRefresh && (
        <RefreshCw className={cn("size-3.5 text-muted-foreground", busy && "animate-spin")} />
      )}
    </button>
  );
});

// 融合(有 action 时):容器 pr-9 预留 + 段宽度 → 整组作一个单元右对齐(+ 右缘与内容列右缘齐平,不再外溢)。
// pill(children)在流内、不占预留区 → 宽高不变(见 SEGMENT_ACTION 只改右端圆角/去右边框)。+ 段绝对定位 right-0
// 落在预留区、齐平 pill 右缘**完全可见**(不掖不遮),自带右半胶囊 + 不透明 bg-card;接缝一条分隔线(z-10)。
// 不 overflow-hidden(否则裁掉弹出的详情面板)。
function ActionShell({ children, action }: { children: ReactNode; action: SyncAction }) {
  return (
    <div className="relative inline-flex pr-9">
      {children}
      <span className="absolute inset-y-1.5 right-9 z-10 w-px bg-border" />
      <button
        type="button"
        onClick={action.onClick}
        aria-label={action.label}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-full border border-l-0 border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
      >
        {action.icon}
      </button>
    </div>
  );
}

// pill 右端与 + 段接缝:去右圆角 + 去右边框(宽高不变)→ 平口对齐 + 段,分隔线落在接缝。
const SEGMENT_ACTION = "rounded-r-none border-r-0";

interface PanelProps {
  summary: SyncStatusSummary;
  /** 这个组合最近一轮(服务端事实);从没同步过 → null。 */
  round: SyncRoundView | null;
  /** **发起**同步这个请求本身失败了 —— 与「这一轮里某个账户失败了」是两回事。 */
  startError: string | null;
  onSync: () => void;
  /** 点某一行 → 去账户页把那一行滚出来(不在当前视图里则开它的详情抽屉)。 */
  onPick: (accountId: string) => void;
  /** 那颗同步按钮点了也没用的时候(在跑 / 请求在飞 / 没有可同步的账户)。 */
  syncDisabled?: boolean;
}

// 一行「标签 …… 值」。面板上半部全是这个形状,单独拎出来是为了那三行不必各抄一遍 class。
function PanelRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2.5 py-1 text-muted-foreground text-xs">
      <span className="shrink-0">{label}</span>
      <span className={cn("min-w-0 truncate text-foreground", mono && "font-mono")}>{value}</span>
    </div>
  );
}

// 一行需要注意的来源:`连接器 @标签` + 那一句状态。
//
// **没有 hover 态**(设计定的):这是一份摘要,鼠标扫过去不该有任何东西亮起来;能点是它的附加功能,
// 不是它的卖点。键盘的 focus 环留着 —— 那不是 hover,少了它 tab 到这儿的人不知道焦点在哪。
//
// 名字写成 `Bitget @现货主号`:账户列表那一行是「标签 + 连接器徽标」,这里不放徽标,于是用同样的
// 两半、纯文字。标签与连接器同名时只出连接器 —— 「Kraken @Kraken」是句废话。
function AttentionRow({
  source,
  connectorLabel,
  onPick,
}: {
  source: SyncAttentionSource;
  connectorLabel: string;
  onPick: (accountId: string) => void;
}) {
  const t = useTranslations("Sync");
  // 活时钟 + 钳位收在 hook 里(为什么不用裸 useNow 见 use-relative-synced-at)。
  const syncedAt = useRelativeSyncedAt();
  const sameName = source.label.trim().toLowerCase() === connectorLabel.trim().toLowerCase();
  const status =
    source.kind === "missing-credentials"
      ? t("missingCredentials")
      : source.kind === "never-synced"
        ? t("neverSynced")
        : t("lastSyncedAt", { when: syncedAt(source.takenAt ?? 0) });
  return (
    <button
      type="button"
      onClick={() => onPick(source.id)}
      className="flex w-full items-baseline justify-between gap-2.5 rounded-sm py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="min-w-0 truncate text-xs">
        <span className="font-medium">{connectorLabel}</span>
        {!sameName && <span className="text-muted-foreground"> @{source.label}</span>}
      </span>
      <span className="shrink-0 text-warn text-xs">{status}</span>
    </button>
  );
}

// 本轮失败的一行:账户名 + 上游原话。**不翻译那句错误** —— 它是上游给的,译一遍只会译歪。
// 与 AttentionRow 同一副骨架但各写各的:那边右侧是四个固定说法之一(短、不换行),这边右侧是
// 一句任意长的错误(要能被挤窄、要能截断),把两者并成一个组件就得在里面开一个开关。
function FailureRow({
  failure,
  onPick,
}: {
  failure: SyncRoundFailure;
  onPick: (accountId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(failure.accountId)}
      className="flex w-full items-baseline justify-between gap-2.5 rounded-sm py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="min-w-0 truncate font-medium text-xs">{failure.label}</span>
      <span className="min-w-0 truncate text-neg text-xs">{failure.error}</span>
    </button>
  );
}

// 共享面板内容(无自身外框/内距 —— 由 Popover 提供表面)。
// 导出只为单测:面板里那几个数是合成出来的(见下面的分子/分母),而经 <SyncStatus> 渲染要先把
// 路由与 Portfolio 上下文一起搭起来 —— 那测的是装配,不是口径。
export function SyncPanel({
  summary,
  round,
  startError,
  onSync,
  onPick,
  syncDisabled,
}: PanelProps) {
  const t = useTranslations("Sync");
  // 活时钟 + 钳位收在 hook 里(为什么不用裸 useNow 见 use-relative-synced-at)。
  const syncedAt = useRelativeSyncedAt();
  const busy = isRoundBusy(round);
  const needsAttention = hasAttention(summary, round, startError);
  const { badge } = tone(busy || needsAttention);
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const nameOf = (id: ConnectorId) => catalog?.[id]?.label ?? connectorLabelFallback(id);
  // 「部分未同步」在这儿会说谎:清单里可能全是「同步过、只是旧了」的,而上面那行明明写着
  // `8 / 8`。「需要注意」把两种都装得下,而且与 pill 上那句是同一句 —— 同一件事不该有两种说法。
  const statusLabel = busy ? t("syncing") : needsAttention ? t("needsAttention") : t("allSynced");

  // **三段式口径**(ADR 0048 裁定 7):synced · failed · need keys,**每个词各管各的**,
  // 为 0 的段省略。以前这里是一个合成分子(打底 + 已完成 - 跳过)夹在 `summary.total` 上,
  // 而那个式子存在的唯一理由是「一个数要同时装下三种不同的事」—— 失败的账户算不算已同步、
  // 缺凭据的算不算跑过,怎么答都得再补一句注释。三个词一摆,这类问题不再需要答案。
  //
  // synced 那段要**加上不参与同步的来源**(手记):它们的值是读的时候现算的,永远是当下,
  // 不算进来就等于说这几个来源没数。
  //
  // **没有轮就没有这一行**(实测裁定):「本轮」是关于某一轮的报告,读不到轮说明**还没跑过**,
  // 不是「跑过了、成绩是这些」。第一版在无轮时拿手记的条数硬凑了一个数,于是新账号那一刻面板写着
  // `This round: 2 synced`,而页头写着 across 10 sources —— 读起来像「10 个来源只同步上 2 个」,
  // 比什么都不说还糟。无轮态只说 `Last updated` 与「需要注意」那份清单,一个 x/y 都不出现。
  const notInRound = Math.max(0, summary.total - summary.accounts.length);
  // synced 段夹在来源总数上:轮中归档一个已同步的账户会让 summary 缩水(total 13 → 12)而
  // 这一轮照旧回 9 条 —— 打底 + 本轮 > 总数,读起来像多同步出一个来源。
  const syncedCount = round ? Math.min(summary.total, round.synced + notInRound) : 0;
  const tally = round
    ? [
        syncedCount > 0 ? t("tallySynced", { count: syncedCount }) : null,
        round.failed.length > 0 ? t("tallyFailed", { count: round.failed.length }) : null,
        round.needsKeys > 0 ? t("tallyNeedsKeys", { count: round.needsKeys }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // **busy 时照样是上次成功同步的时间**(裁定 3)。以前这里写死 `—`,恰好在最该看它的那一刻
  // 把它抹掉:正在同步 = 屏幕上的数还是旧的,「旧到什么时候」是此刻唯一有用的信息。
  const lastUpdated = summary.lastSyncedAt ? syncedAt(summary.lastSyncedAt) : t("lastNever");

  // 那一行三态,**同一个位置只说一件事**:
  //   · 进行中   —— `x / N` + 正在同步谁
  //   · 有轮可报 —— 三段式
  //   · 没有轮   —— 这个组合有几个来源
  //
  // 最后那一态不是占位:面板叫「同步状态」,「这个组合里有几个来源」是它的本分,而且它天然随组合
  // 变(切一下组合这个数就该跟着换)。**但它绝不能长成一个 x/y** —— 一旦写成分数,读的人会当成
  // 「同步上几个」,而无轮态恰恰是「还没跑过」,一个都还没同步。所以有轮时不把来源数塞进三段式:
  // 那一行是关于某一轮的报告,不是关于组合的统计。
  const roundRows =
    round && busy ? (
      <>
        <PanelRow label={t("roundProgress")} value={`${round.settled} / ${round.total}`} mono />
        <PanelRow label={t("syncingNow")} value={round.current ?? "…"} />
      </>
    ) : tally ? (
      <PanelRow label={t("roundResult")} value={tally} />
    ) : (
      <PanelRow label={t("sources")} value={summary.total} mono />
    );

  // 中断 = 未收官且心跳断了(worker 死了)。它不是某个账户的失败,所以没有清单可列,
  // 只有一句「上一轮没跑完」—— 但它必须出现,否则一轮假同步在面板上与「一切正常」无异。
  const interrupted = round?.state === "interrupted";
  const fatal = startError ? `${t("startFailed")}: ${startError}` : (round?.error ?? null);
  const failures = round?.failed ?? [];
  const failureBlock =
    failures.length > 0 || fatal || interrupted ? (
      <>
        <div className="my-2 border-border border-t" />
        <div className="pb-0.5 font-medium text-muted-foreground text-xs">{t("roundFailed")}</div>
        <div className="flex flex-col">
          {failures.map((f) => (
            <FailureRow key={f.accountId} failure={f} onPick={onPick} />
          ))}
          {fatal ? <p className="py-1 text-neg text-xs">{fatal}</p> : null}
          {interrupted ? <p className="py-1 text-warn text-xs">{t("roundInterrupted")}</p> : null}
        </div>
      </>
    ) : null;

  const attentionBlock =
    summary.attention.length > 0 ? (
      <>
        <div className="my-2 border-border border-t" />
        <div className="flex flex-col">
          {summary.attention.map((a) => (
            <AttentionRow
              key={a.id}
              source={a}
              connectorLabel={nameOf(a.connectorId)}
              onPick={onPick}
            />
          ))}
        </div>
      </>
    ) : null;

  return (
    <div className="w-72 text-left">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="font-semibold text-sm">{t("status")}</span>
        <span className={cn("rounded-full px-2 py-0.5 font-semibold text-xs", badge)}>
          {statusLabel}
        </span>
      </div>

      {roundRows}
      <PanelRow label={t("lastUpdated")} value={lastUpdated} mono />

      {/* 两份清单合用一个封顶的滚动区:面板现在在手机上也是 popover(锚在页头下方),清单一长
          就会顶到屏幕底下 —— 而这张面板最后一行正是那颗同步按钮,够不着它等于这个入口废了。
          max-h-64 是「大约十行」,再多就滚。 */}
      {failureBlock || attentionBlock ? (
        <div className="max-h-64 overflow-y-auto">
          {failureBlock}
          {attentionBlock}
        </div>
      ) : null}

      <div className="my-2 border-border border-t" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {busy ? t("hintSyncing") : t("hintResync")}
        </span>
        <IconButton
          size="sm"
          variant="outline"
          onClick={onSync}
          disabled={syncDisabled ?? (busy || summary.accounts.length === 0)}
          aria-label={t("status")}
          className="shrink-0 text-foreground [&_svg]:size-3.5"
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * 「有事要看一眼」= 摘要那份清单 + 本组合上一轮出的事。
 *
 * 后三样摘要都看不见:一个**失败**的账户往往仍有旧快照、凭据也齐,于是它不进 attention;
 * **整轮没跑起来**根本没到落库那一步;**中断**更是连结果都没有。不把它们算进来的话,
 * 一轮同步炸了三个,徽标照样绿着说「已同步」。
 *
 * 纯函数导出,单测直接喂数据(经 <SyncStatus> 测它要先搭路由 + Portfolio 上下文)。
 */
export function hasAttention(
  summary: SyncStatusSummary,
  round: SyncRoundView | null,
  startError: string | null = null,
): boolean {
  return (
    summary.attention.length > 0 ||
    startError !== null ||
    (round != null &&
      (round.failed.length > 0 || round.error !== null || round.state === "interrupted"))
  );
}

export function SyncStatus({
  summary,
  action,
}: {
  summary: SyncStatusSummary;
  action?: SyncAction;
}) {
  const t = useTranslations("Sync");
  // 同步这一轮按**当前组合**跑(ADR 0047)—— 名单在服务端算,这里只把组合传下去。
  const { selectedId } = usePortfolio();
  // 这一轮的一切从服务端来(ADR 0048):hook 只管发起与读,不再自己记进度。
  const { round, busy, disabled, startError, sync } = useSyncRound(
    selectedId,
    summary.accounts.length,
  );
  // 打开方式按**指针能力**分,不按视口宽度:触屏上的 hover 是 tap 之后粘住的幽灵态,面板会莫名其妙
  // 留在屏幕上。宽度不是判据 —— 触屏笔记本也该是 tap。
  const hoverCapable = useHoverCapable();
  // 受控:点面板里的某一行会导航走,得先把面板关上;而且下面那两个 className 补丁也要读这个状态。
  // 打开态抬 z-50(beUI Popover root 是 isolate 层叠上下文,否则被 hero 数值层盖住);
  // 闭合时隐藏 goo 背板(aria-hidden 首子元素),免透明状态段透出 bg-popover 块(同 useHoverPopover 的手法)。
  const [open, setOpen] = useState(false);

  const navigate = useNavigate();
  // 点一行 → 去账户页把那一行滚出来。**跳转带 `focus`,滚动那件事由账户页自己做**(那边才知道
  // 当前 Portfolio 视图里有哪些行);那一行不在视图里时它会退成开详情抽屉。
  const pick = (accountId: string) => {
    setOpen(false);
    navigate({ to: "/accounts", search: { focus: accountId } });
  };

  const needsAttention = hasAttention(summary, round, startError);
  const { dot } = tone(busy || needsAttention);
  // pill 上那句刻意更短(「已同步」而不是「全部同步」)—— 它在页头里跟其他段并排,字多了会挤。
  // 但要注意的那句两处一致:同一件事不该有两种说法。
  const triggerLabel = busy
    ? t("triggerSyncing")
    : needsAttention
      ? t("needsAttention")
      : t("triggerSynced");

  // 有鼠标:hover 开面板,点 pill 直接同步(点开一个 hover 就有的面板是白点一下)。
  // 触屏:tap 开面板,同步走面板里那颗按钮 —— 一个手势不能既开面板又开跑。
  const popover = (
    <Popover
      trigger={hoverCapable ? "hover" : "click"}
      side="bottom"
      align="end"
      // 18 = h-9 触发器半高:goo 影子 pill 半径 = min(triggerH/2, panelRadius),须 ≥18 才与 rounded-full 触发器
      // 齐圆,否则更方的影子 pill 四角探出成多余阴影。
      panelRadius={18}
      open={open}
      onOpenChange={setOpen}
      className={cn(open ? "z-50" : "[&>[aria-hidden]]:hidden")}
    >
      <PopoverTrigger>
        <StatusSegment
          label={triggerLabel}
          dotClass={dot}
          busy={busy}
          showRefresh={!action}
          className={action ? SEGMENT_ACTION : undefined}
          onClick={hoverCapable ? sync : undefined}
        />
      </PopoverTrigger>
      <PopoverContent>
        <SyncPanel
          summary={summary}
          round={round}
          startError={startError}
          onSync={sync}
          onPick={pick}
          syncDisabled={disabled}
        />
      </PopoverContent>
    </Popover>
  );

  // action 段(+)在 Popover 外右侧并排 → hover/tap 它不开面板。
  return action ? <ActionShell action={action}>{popover}</ActionShell> : popover;
}
