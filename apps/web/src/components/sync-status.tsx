import type { ConnectorId } from "@folio/connectors";
import { cn, Popover, PopoverContent, PopoverTrigger, useHoverCapable } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import { useFormatter, useNow, useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import {
  type SyncRound,
  type SyncRoundFailure,
  useAccountSync,
} from "@/lib/hooks/use-account-sync";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import type { SyncAttentionSource, SyncStatusSummary } from "@/lib/server/sync/status";
import { IconButton } from "./icon-button";

// 共享同步状态入口(PageHeader actions):**一个 Popover**,有鼠标就 hover 打开、触屏就 tap 打开,
// 两边包的是同一份 <SyncPanel>(状态徽章 + 已同步/总来源 + 上次更新 + 本轮进度与失败 + 需要注意的来源
// + 独立同步按钮)。
//
// 移动端以前走 MorphingModal(从底部升起的卡片)。换掉它是因为那张卡的底行被悬浮 Dock 压住截断,
// 而 Dock 是固定的、卡片是居中的 —— 抬高只能是一个魔数在跟另一个魔数赛跑。锚在触发器下方的 popover
// 根本不到那一带,遮挡这件事随形态统一消失(FOL-32 裁定 2)。
//
// 全量同步的进度**长在这张面板里**,不再另发 toast(裁定 1):toast 与面板各有一套分母,同屏对不上。
// toast 只留给账户详情里的单账户同步 —— 那一处没有面板可长。
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
  /** 这一轮的进度(没在跑时是上一轮留下的失败清单)。 */
  round: SyncRound;
  busy: boolean;
  /** 有事要看一眼(摘要里的清单,或上一轮的失败)—— 不含「正在同步」。 */
  needsAttention: boolean;
  onSync: () => void;
  /** 点某一行 → 去账户页把那一行滚出来(不在当前视图里则开它的详情抽屉)。 */
  onPick: (accountId: string) => void;
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
  const format = useFormatter();
  // 相对时间要一个**活的**now:provider 的 now 冻在页面加载那一刻,页面开着不关的话,
  // 刚同步完的时间戳会比它还新,渲染成「in 2 minutes」这种未来时态(实测抓到)。useNow 初值
  // 取 provider 那份(SSR/hydration 一致),挂载后每分钟自更新 —— 粒度与展示单位一致。
  // 调用点仍要把时间戳钳到 now:快照落库到下一跳之间,新时间戳照样比 now 新。
  const now = useNow({ updateInterval: 60_000 });
  const sameName = source.label.trim().toLowerCase() === connectorLabel.trim().toLowerCase();
  const status =
    source.kind === "missing-credentials"
      ? t("missingCredentials")
      : source.kind === "never-synced"
        ? t("neverSynced")
        : t("lastSyncedAt", {
            when: format.relativeTime(new Date(Math.min(source.takenAt ?? 0, now.getTime())), now),
          });
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
export function SyncPanel({ summary, round, busy, needsAttention, onSync, onPick }: PanelProps) {
  const t = useTranslations("Sync");
  const format = useFormatter();
  // 相对时间要一个**活的**now:provider 的 now 冻在页面加载那一刻,页面开着不关的话,
  // 刚同步完的时间戳会比它还新,渲染成「in 2 minutes」这种未来时态(实测抓到)。useNow 初值
  // 取 provider 那份(SSR/hydration 一致),挂载后每分钟自更新 —— 粒度与展示单位一致。
  // 调用点仍要把时间戳钳到 now:快照落库到下一跳之间,新时间戳照样比 now 新。
  const now = useNow({ updateInterval: 60_000 });
  const { badge } = tone(busy || needsAttention);
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const nameOf = (id: ConnectorId) => catalog?.[id]?.label ?? connectorLabelFallback(id);
  // 「部分未同步」在这儿会说谎:清单里可能全是「同步过、只是旧了」的,而上面那行明明写着
  // `8 / 8`。「需要注意」把两种都装得下,而且与 pill 上那句是同一句 —— 同一件事不该有两种说法。
  const statusLabel = busy ? t("syncing") : needsAttention ? t("needsAttention") : t("allSynced");

  // **一个数,一个分母**(裁定 3)。分母恒是「组合内全部来源」(`summary.total`,含手记);
  // 同步中的分子 = 不参与这一轮的来源打底(手记那些一直有数)+ 本轮已完成数。于是一轮从 `4/13`
  // 起步涨到 `13/13`,与静态时那个 `ok / total` 是同一个数字、同一个分母。
  // 以前这里静态写 `13 / 13`、顶上另有一条 toast 写 `7 / 9` —— 两套分母同屏,而且都不假。
  //
  // 夹在分母上:summary 每完成一个账户就被定向刷新,轮中归档一个**已同步**的账户会让打底 + 已完成
  // 大过缩了水的 total(13 个来源归档 1 个 → total 12,而这一轮照旧回 9 条)—— `13 / 12` 读起来
  // 像多同步出一个来源。
  const notInRound = summary.total - summary.accounts.length;
  const synced = busy ? Math.min(summary.total, notInRound + round.done) : summary.ok;

  // **busy 时照样是上次成功同步的时间**(裁定 3)。以前这里写死 `—`,恰好在最该看它的那一刻
  // 把它抹掉:正在同步 = 屏幕上的数还是旧的,「旧到什么时候」是此刻唯一有用的信息。
  const lastUpdated = summary.lastSyncedAt
    ? format.relativeTime(new Date(Math.min(summary.lastSyncedAt, now.getTime())), now)
    : t("lastNever");

  const currentRow = busy ? (
    <div className="flex items-center justify-between gap-2.5 py-1 text-muted-foreground text-xs">
      <span className="shrink-0">{t("syncingNow")}</span>
      <span className="min-w-0 truncate text-foreground">{round.current ?? "…"}</span>
    </div>
  ) : null;

  const failureBlock =
    round.failures.length > 0 || round.error ? (
      <>
        <div className="my-2 border-border border-t" />
        <div className="pb-0.5 font-medium text-muted-foreground text-xs">{t("roundFailed")}</div>
        <div className="flex flex-col">
          {round.failures.map((f) => (
            <FailureRow key={f.accountId} failure={f} onPick={onPick} />
          ))}
          {round.error ? <p className="py-1 text-neg text-xs">{round.error}</p> : null}
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

      <div className="flex items-center justify-between py-1 text-muted-foreground text-xs">
        <span>{t("sourcesSynced")}</span>
        <span className="font-mono font-semibold text-foreground">
          {synced} / {summary.total}
        </span>
      </div>
      <div className="flex items-center justify-between py-1 text-muted-foreground text-xs">
        <span>{t("lastUpdated")}</span>
        <span className="font-mono text-foreground">{lastUpdated}</span>
      </div>
      {currentRow}

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
          disabled={busy || summary.accounts.length === 0}
          aria-label={t("status")}
          className="shrink-0 text-foreground [&_svg]:size-3.5"
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </IconButton>
      </div>
    </div>
  );
}

// 「有事要看一眼」= 摘要那份清单 + 本组合上一轮的失败。后者摘要看不见:一个失败的账户往往仍有
// 旧快照、凭据也齐,于是它不进 attention —— 不把它算进来的话,一轮同步炸了三个,徽标照样绿着说
// 「已同步」。纯函数导出,单测直接喂数据(经 <SyncStatus> 测它要先搭路由 + Portfolio 上下文)。
export function hasAttention(summary: SyncStatusSummary, round: SyncRound): boolean {
  return summary.attention.length > 0 || round.failures.length > 0 || round.error !== null;
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
  const { busy, sync, round } = useAccountSync(summary.accounts, selectedId);
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

  const needsAttention = hasAttention(summary, round);
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
          busy={busy}
          needsAttention={needsAttention}
          onSync={sync}
          onPick={pick}
        />
      </PopoverContent>
    </Popover>
  );

  // action 段(+)在 Popover 外右侧并排 → hover/tap 它不开面板。
  return action ? <ActionShell action={action}>{popover}</ActionShell> : popover;
}
