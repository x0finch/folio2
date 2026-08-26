import type { ConnectorId } from "@folio/connectors";
import { cn, MorphingModal, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { connectorLabelFallback } from "@/lib/core/logo";
import { useAccountSync } from "@/lib/hooks/use-account-sync";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import type { SyncAttentionSource, SyncStatusSummary } from "@/lib/server/sync/status";
import { IconButton } from "./icon-button";

// 共享同步状态入口(PageHeader actions):桌面 hover Popover、移动 tap MorphingModal,
// 包裹同一份 <SyncPanel> 内容(状态徽章 + ok/总数 + 上次更新 + 失败来源 + 独立同步按钮)。
// 逻辑走共享 useAccountSync(并发同步 + toast 进度);失败来源 = 缺凭据账户(见 sync-status 摘要)。
//
// 分段按钮(beUI 胶囊):可选 action → 状态段右侧接「分隔线 + 自定义 icon 段」(如账户页的 + 添加账户)。
// 有 action 时状态段**不显旋转刷新图标**(进度走 toast + 面板);无 action 时保持单枚 pill + 刷新图标。

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
// 半径对齐 → 无多余阴影;bg-card 亦作遮罩盖住其后的 + 段掖进部分。有 action 时仅隐去刷新图标(进度走 toast)。
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
  busy: boolean;
  attention: boolean;
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
  const sameName = source.label.trim().toLowerCase() === connectorLabel.trim().toLowerCase();
  const status =
    source.kind === "missing-credentials"
      ? t("missingCredentials")
      : source.kind === "never-synced"
        ? t("neverSynced")
        : t("lastSyncedAt", { when: format.relativeTime(new Date(source.takenAt ?? 0)) });
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

// 共享面板内容(无自身外框/内距 —— 由 Popover/MorphingModal 提供表面)。
function SyncPanel({ summary, busy, attention, onSync, onPick }: PanelProps) {
  const t = useTranslations("Sync");
  const format = useFormatter();
  const { badge } = tone(attention);
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const nameOf = (id: ConnectorId) => catalog?.[id]?.label ?? connectorLabelFallback(id);
  // 「部分未同步」在这儿会说谎:清单里可能全是「同步过、只是旧了」的,而上面那行明明写着
  // `8 / 8`。「需要注意」把两种都装得下,而且与 pill 上那句是同一句 —— 同一件事不该有两种说法。
  const statusLabel = busy
    ? t("syncing")
    : summary.attention.length > 0
      ? t("needsAttention")
      : t("allSynced");
  const lastUpdated = busy
    ? "—"
    : summary.lastSyncedAt
      ? format.relativeTime(new Date(summary.lastSyncedAt))
      : t("lastNever");

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
          {summary.ok} / {summary.total}
        </span>
      </div>
      <div className="flex items-center justify-between py-1 text-muted-foreground text-xs">
        <span>{t("lastUpdated")}</span>
        <span className="font-mono text-foreground">{lastUpdated}</span>
      </div>

      {summary.attention.length > 0 ? (
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
  const { busy, sync } = useAccountSync(summary.accounts, selectedId);
  const [modalOpen, setModalOpen] = useState(false);
  // 桌面 hover popover 打开态抬 z-50(beUI Popover root 是 isolate 层叠上下文,否则被 hero 数值层盖住);
  // 闭合时隐藏 goo 背板(aria-hidden 首子元素),免透明状态段透出 bg-popover 块(同 useHoverPopover 的手法)。
  const [popoverOpen, setPopoverOpen] = useState(false);

  const navigate = useNavigate();
  // 点一行 → 去账户页把那一行滚出来。**跳转带 `focus`,滚动那件事由账户页自己做**(那边才知道
  // 当前 Portfolio 视图里有哪些行);那一行不在视图里时它会退成开详情抽屉。
  const pick = (accountId: string) => {
    setModalOpen(false);
    navigate({ to: "/accounts", search: { focus: accountId } });
  };

  const attention = busy || summary.attention.length > 0;
  const { dot } = tone(attention);
  // pill 上那句刻意更短(「已同步」而不是「全部同步」)—— 它在页头里跟其他段并排,字多了会挤。
  // 但要注意的那句两处一致:同一件事不该有两种说法。
  const triggerLabel = busy
    ? t("triggerSyncing")
    : summary.attention.length > 0
      ? t("needsAttention")
      : t("triggerSynced");

  // 桌面:hover Popover 包同步钮;action 段(+)在 Popover 外右侧并排 → hover + 不开面板。
  const desktopPopover = (
    <Popover
      trigger="hover"
      side="bottom"
      align="end"
      // 18 = h-9 触发器半高:goo 影子 pill 半径 = min(triggerH/2, panelRadius),须 ≥18 才与 rounded-full 触发器
      // 齐圆,否则更方的影子 pill 四角探出成多余阴影。
      panelRadius={18}
      onOpenChange={setPopoverOpen}
      className={cn(popoverOpen ? "z-50" : "[&>[aria-hidden]]:hidden")}
    >
      <PopoverTrigger>
        <StatusSegment
          label={triggerLabel}
          dotClass={dot}
          busy={busy}
          showRefresh={!action}
          className={action ? SEGMENT_ACTION : undefined}
          onClick={sync}
        />
      </PopoverTrigger>
      <PopoverContent>
        <SyncPanel
          summary={summary}
          busy={busy}
          attention={attention}
          onSync={sync}
          onPick={pick}
        />
      </PopoverContent>
    </Popover>
  );

  const mobileSeg = (
    <StatusSegment
      label={triggerLabel}
      dotClass={dot}
      busy={busy}
      showRefresh={!action}
      className={action ? SEGMENT_ACTION : undefined}
      onClick={() => setModalOpen(true)}
    />
  );

  return (
    <>
      <div className="hidden lg:block">
        {action ? <ActionShell action={action}>{desktopPopover}</ActionShell> : desktopPopover}
      </div>

      <div className="lg:hidden">
        {action ? <ActionShell action={action}>{mobileSeg}</ActionShell> : mobileSeg}
        <MorphingModal viewId={modalOpen ? "sync" : null} onClose={() => setModalOpen(false)}>
          <SyncPanel
            summary={summary}
            busy={busy}
            attention={attention}
            onSync={sync}
            onPick={pick}
          />
        </MorphingModal>
      </div>
    </>
  );
}
