import { cn, MorphingModal, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { RefreshCw } from "lucide-react";
import { forwardRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { useAccountSync } from "../lib/hooks/use-account-sync";
import type { SyncStatusSummary } from "../lib/sync-status";

// 共享同步状态入口(PageHeader actions):桌面 hover Popover、移动 tap MorphingModal,
// 包裹同一份 <SyncPanel> 内容(状态徽章 + ok/总数 + 上次更新 + 失败来源 + 独立同步按钮)。
// 逻辑走共享 useAccountSync(并发同步 + toast 进度);失败来源 = 缺凭据账户(见 sync-status 摘要)。

// 状态色调:同步中或有失败 → warn;否则 pos(与设计 syncStatusTone 一致)。
function tone(attention: boolean) {
  return attention
    ? { dot: "bg-warn", badge: "bg-warn-bg text-warn" }
    : { dot: "bg-pos", badge: "bg-pos-bg text-pos" };
}

interface TriggerProps extends React.ComponentPropsWithoutRef<"button"> {
  label: string;
  dotClass: string;
  busy: boolean;
}

// 触发钮(桌面/移动共用样式):状态点 + 文案 + 刷新图标(同步中旋转)。
// forwardRef + 透传 rest → 可作 PopoverTrigger 的唯一子元素(注入 ref/onFocus/aria)。
const SyncTrigger = forwardRef<HTMLButtonElement, TriggerProps>(function SyncTrigger(
  { label, dotClass, busy, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 font-mono text-foreground text-xs transition-colors hover:bg-muted",
        className,
      )}
      {...rest}
    >
      <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
      <span className="text-muted-foreground">{label}</span>
      <RefreshCw className={cn("size-3.5 text-muted-foreground", busy && "animate-spin")} />
    </button>
  );
});

interface PanelProps {
  summary: SyncStatusSummary;
  busy: boolean;
  attention: boolean;
  onSync: () => void;
}

// 共享面板内容(无自身外框/内距 —— 由 Popover/MorphingModal 提供表面)。
function SyncPanel({ summary, busy, attention, onSync }: PanelProps) {
  const t = useTranslations("Sync");
  const format = useFormatter();
  const { badge } = tone(attention);
  const statusLabel = busy
    ? t("syncing")
    : summary.failed.length > 0
      ? t("partial")
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

      {summary.failed.length > 0 ? (
        <>
          <div className="my-2 border-border border-t" />
          <div className="mb-1.5 text-muted-foreground text-xs uppercase tracking-wider">
            {t("notSynced")}
          </div>
          <ul className="flex flex-col gap-1.5">
            {summary.failed.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
                <div className="min-w-0">
                  <div className="font-medium text-xs">{f.label}</div>
                  <div className="text-warn text-xs leading-snug">{t("missingCredentials")}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="my-2 border-border border-t" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {busy ? t("hintSyncing") : t("hintResync")}
        </span>
        <button
          type="button"
          onClick={onSync}
          disabled={busy || summary.accounts.length === 0}
          aria-label={t("status")}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50 [&_svg]:size-3.5"
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </button>
      </div>
    </div>
  );
}

export function SyncStatus({ summary }: { summary: SyncStatusSummary }) {
  const t = useTranslations("Sync");
  const { busy, sync } = useAccountSync(summary.accounts);
  const [modalOpen, setModalOpen] = useState(false);

  const attention = busy || summary.failed.length > 0;
  const { dot } = tone(attention);
  const triggerLabel = busy
    ? t("triggerSyncing")
    : summary.failed.length > 0
      ? t("triggerAttention")
      : t("triggerSynced");

  return (
    <>
      {/* 桌面:hover Popover */}
      <div className="hidden lg:block">
        <Popover trigger="hover" side="bottom" align="end" panelRadius={14}>
          <PopoverTrigger>
            <SyncTrigger label={triggerLabel} dotClass={dot} busy={busy} onClick={sync} />
          </PopoverTrigger>
          <PopoverContent>
            <SyncPanel summary={summary} busy={busy} attention={attention} onSync={sync} />
          </PopoverContent>
        </Popover>
      </div>

      {/* 移动:tap MorphingModal */}
      <div className="lg:hidden">
        <SyncTrigger
          label={triggerLabel}
          dotClass={dot}
          busy={busy}
          onClick={() => setModalOpen(true)}
        />
        <MorphingModal viewId={modalOpen ? "sync" : null} onClose={() => setModalOpen(false)}>
          <SyncPanel summary={summary} busy={busy} attention={attention} onSync={sync} />
        </MorphingModal>
      </div>
    </>
  );
}
