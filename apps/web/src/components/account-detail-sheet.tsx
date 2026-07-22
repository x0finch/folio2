import type { ConnectorId } from "@folio/connectors";
import type { Note } from "@folio/connectors-basic";
import {
  BottomSheet,
  Button,
  cn,
  Drawer,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, Archive, MoreVertical, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { accountShare, shareLabel } from "../lib/account-share";
import type { OverviewBalance } from "../lib/account-view";
import { aggregateDayChange } from "../lib/day-value-change";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { useHoverPopover } from "../lib/hooks/use-hover-popover";
import { deleteAccount, renameAccount, setAccountArchived } from "../lib/server/accounts";
import { getAccountValueHistory } from "../lib/server/history";
import { syncOneAccount } from "../lib/server/sync";
import { signedUsd } from "../lib/signed-usd";
import { ConnectorBadge } from "./connector-badge";
import { AccountHoldingsCards } from "./holdings-cards";
import { ManualTokensPanel } from "./manual-tokens-panel";
import { type Range, RangeTabs, rangeSince } from "./range-tabs";
import { ValueTrendChart } from "./value-trend-chart";

// 账户页列表行的合并形状(getMyOverview ∪ listMyAccounts,见 accounts.tsx loader)。
export interface AccountRow {
  id: string;
  label: string;
  connectorId: ConnectorId;
  archivedAt: number | null;
  totalUsd: number;
  takenAt: number | null;
  balances: OverviewBalance[]; // 各持仓自带 balance 级 note(note 重设计)
  note?: Note[]; // account 级展示 note(Note[],整钱包;BTC 未确认/收款/派生分布)
  needsCredentials: boolean;
  credsSafe: Record<string, string>;
}

// 账户详情抽屉(A2):桌面右滑 Drawer、移动 BottomSheet 承载同一份 <DetailBody>(照 asset-sheet 模式)。
// 头部 = 账户价值历史图垫底 + 窗口切换 + ⋯ 菜单(同步/归档/删除);点名字内联重命名。全部持仓复用主页组件。
export function AccountDetailSheet({
  account,
  total,
  open,
  onOpenChange,
  onComplete,
}: {
  account: AccountRow | null;
  total: number; // 活跃账户总计 —— 抽屉头占比分母(见 accounts.tsx)
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (account: AccountRow) => void; // 补录:打开加账户 modal 的补录模式(A3)
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // key={account.id} 重挂 → 切账户自动清空 rename/confirm/range 等本地态。
  const body = account && (
    <DetailBody
      key={account.id}
      account={account}
      total={total}
      onClose={() => onOpenChange(false)}
      onComplete={() => onComplete(account)}
    />
  );

  if (isDesktop) {
    return (
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        side="right"
        ariaLabel={account?.label}
        className="w-full overflow-y-auto p-6 sm:max-w-lg"
      >
        {body}
      </Drawer>
    );
  }
  // title 不传:内容头部已渲染账户名,避免 BottomSheet 自带标题区重复。
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} snapPoints={[0.6, 0.92]}>
      {body}
    </BottomSheet>
  );
}

const menuItemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50";

function DetailBody({
  account,
  total,
  onClose,
  onComplete,
}: {
  account: AccountRow;
  total: number;
  onClose: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const usd = useDisplayValue();
  const router = useRouter();
  const refresh = () => router.invalidate();

  // 头部 24h 增量与账户行同源(缺凭据 → 不显增量);占比 = 本账户市值 / 活跃账户总计。
  const dayChange = account.needsCredentials ? null : aggregateDayChange(account.balances);
  const sharePct = accountShare(account.totalUsd, total) * 100;

  const archived = account.archivedAt != null;
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // ⋯ 菜单走全站统一的 hover popover 行为(关闭态隐 goo 垫底 → ghost 触发器不露 bg-popover 块;
  // 动态 side / 抬 z)。hover 触发,离开即收,不需受控关闭。
  const menuPop = useHoverPopover();

  // 头部背景 = 账户价值历史(窗口可切);末点 = 最新快照冻结总额,与 account.totalUsd 同源 → 曲线当下点 ≡ 头部数值。
  const [range, setRange] = useState<Range>("30d");
  const historyQuery = useQuery({
    queryKey: ["account-history", account.id, range],
    queryFn: () =>
      getAccountValueHistory({
        data: { accountId: account.id, since: rangeSince(range, Date.now()) },
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const series = historyQuery.data?.series ?? [];

  // 操作反馈统一走 toast(D07):同步给出成/败,写操作失败提示,成功以列表刷新为可见反馈。
  const syncMut = useMutation({
    mutationFn: () => syncOneAccount({ data: { accountId: account.id } }),
    onSuccess: async (r) => {
      if (r.ok) toast.success(t("synced", { count: 1 }));
      else if (!r.skipped) toast.error(r.error ?? t("syncGenericError"));
      await refresh();
    },
    onError: () => toast.error(t("syncGenericError")),
  });
  const renameMut = useMutation({
    mutationFn: () => renameAccount({ data: { accountId: account.id, label: labelDraft.trim() } }),
    onSuccess: async () => {
      setRenaming(false);
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });
  const archiveMut = useMutation({
    mutationFn: () => setAccountArchived({ data: { accountId: account.id, archived: !archived } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteAccount({ data: { accountId: account.id } }),
    onSuccess: async () => {
      onClose();
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });

  const lastSynced = account.takenAt
    ? t("lastSyncedAt", { when: format.relativeTime(new Date(account.takenAt)) })
    : t("neverSynced");

  return (
    <>
      {/* 头部:价值历史图垫底;窗口切换叠右下角、⋯ 菜单叠右上角;名称/市值/占比浮其上。
          预留固定高度(min-h-44)→ 图异步到达不撑高、不挤压列表。 */}
      <div className="relative">
        <div className="relative min-h-44">
          {/* chart 单独一层裁溢出;名称层浮其上不受裁 → 左上角铅笔角标不被 overflow-hidden 切掉。 */}
          {series.length >= 2 && (
            <div className="absolute inset-0 overflow-hidden">
              <ValueTrendChart series={series} topMargin={56} fillOpacity={0.14} />
            </div>
          )}

          {/* 窗口切换:右下角独占一带(与 asset-sheet 一致)。 */}
          <div className="absolute right-0 bottom-0 z-10">
            <RangeTabs value={range} onChange={setRange} />
          </div>

          <div className="relative flex flex-col gap-1.5">
            {/* pr-10 给右上角 ⋯ 让位,名称不钻到按钮下。 */}
            <div className="flex min-w-0 items-center gap-2 pr-10">
              {renaming ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    renameMut.mutate();
                  }}
                >
                  <Input
                    autoFocus
                    value={labelDraft}
                    onChange={(v) => setLabelDraft(v)}
                    className="h-8"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={renameMut.isPending || !labelDraft.trim()}
                  >
                    {renameMut.isPending ? tc("verifying") : tc("save")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLabelDraft(account.label);
                      setRenaming(false);
                    }}
                  >
                    {tc("cancel")}
                  </Button>
                </form>
              ) : (
                // 点名字进入内联重命名;hover 名字:右上角浮出小铅笔角标。
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="group relative rounded-md text-left outline-none"
                >
                  {/* 名称字号同代币抽屉头部(text-lg semibold)。 */}
                  <span className="font-semibold text-lg">{account.label}</span>
                  {/* 铅笔作右上角角标:绝对定位、不占行宽;hover/聚焦才现。 */}
                  <Pencil
                    className="pointer-events-none absolute -top-1.5 -right-2 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden
                  />
                </button>
              )}
              {!renaming && <ConnectorBadge connectorId={account.connectorId} />}
              {!renaming && archived && (
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                  {t("archivedBadge")}
                </span>
              )}
            </div>
            {/* 市值 + 24h 增量:字号同代币抽屉(值 text-3xl bold、增量 text-sm);缺凭据 → 无增量。 */}
            <div>
              <div className="font-bold text-3xl tabular-nums">{usd(account.totalUsd)}</div>
              {dayChange && dayChange.delta !== 0 && (
                <div
                  className={cn(
                    "mt-1 text-sm tabular-nums",
                    dayChange.delta > 0 ? "text-pos" : "text-neg",
                  )}
                >
                  {signedUsd(usd, dayChange.delta)}
                  {dayChange.pct != null ? ` ${Math.abs(dayChange.pct).toFixed(2)}%` : ""}
                </div>
              )}
            </div>
            {/* 缺凭据告警行:⚠ + 可点击"补填凭据以同步"提示(文案即入口 → 开加账户 modal 的补录模式,A3)。 */}
            {account.needsCredentials && (
              <div className="flex items-center gap-1.5 text-warn text-xs">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                <button
                  type="button"
                  onClick={onComplete}
                  className="rounded-sm underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-1 focus-visible:ring-warn"
                >
                  {t("completePrompt")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ⋯ 更多:竖向三点、outline 触发器;放在 overflow-hidden 外层 → 菜单弹层不被头部裁剪。 */}
        <div className="absolute top-0 right-0 z-20">
          <Popover
            trigger="hover"
            side={menuPop.side}
            align="end"
            panelRadius={12}
            onOpenChange={menuPop.onOpenChange}
            className={menuPop.rootClassName}
          >
            <PopoverTrigger>
              <button
                ref={menuPop.measureRef}
                type="button"
                aria-label={t("moreActions")}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreVertical className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex w-40 flex-col gap-0.5">
                <button
                  type="button"
                  className={menuItemClass}
                  disabled={archived || syncMut.isPending}
                  onClick={() => syncMut.mutate()}
                >
                  <RefreshCw className="size-4 shrink-0" />
                  {t("syncThis")}
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  disabled={archiveMut.isPending}
                  onClick={() => archiveMut.mutate()}
                >
                  <Archive className="size-4 shrink-0" />
                  {archived ? t("unarchive") : t("archive")}
                </button>
                <button
                  type="button"
                  className={cn(menuItemClass, "text-destructive hover:text-destructive")}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="size-4 shrink-0" />
                  {tc("delete")}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* 占比 + 同步时间:移到图下方,更小字体 + 更淡(次要信息,弱化)。 */}
      <p className="mt-2 text-muted-foreground/30 text-xs">
        {!archived && sharePct > 0 && `${t("shareOfTotal", { pct: shareLabel(sharePct) })} · `}
        {lastSynced}
      </p>

      {confirmDelete && (
        <div className="mt-4 flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-destructive text-sm">{t("deleteConfirm")}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMut.isPending}
            >
              {tc("cancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? tc("verifying") : t("deleteConfirmBtn")}
            </Button>
          </div>
        </div>
      )}

      {/* manual 账户:多 token 面板(Tokens tab 已含持仓,故不再叠加上方持仓卡)。
          非-manual:持仓卡片列表 + provider 明细手风琴(缺凭据带导入快照 → 渲染陈旧持仓;无快照 → 内部空态)。 */}
      {account.connectorId === "manual" ? (
        <div className="mt-6">
          <ManualTokensPanel balances={account.balances} />
        </div>
      ) : (
        <div className="mt-6">
          <AccountHoldingsCards balances={account.balances} accountNote={account.note} />
        </div>
      )}
    </>
  );
}
