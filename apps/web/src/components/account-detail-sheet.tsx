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
import { Archive, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { accountShare, shareLabel } from "../lib/account-share";
import type { OverviewBalance } from "../lib/account-view";
import { aggregateDayChange } from "../lib/day-value-change";
import { deleteAccount, renameAccount, setAccountArchived } from "../lib/server/accounts";
import type { InputSpec } from "../lib/server/credentials";
import { getAccountValueHistory } from "../lib/server/history";
import { syncOneAccount } from "../lib/server/sync";
import { ConnectorBadge } from "./connector-badge";
import { CredentialForm } from "./credential-form";
import { AccountHoldingsCards } from "./holdings-cards";
import { ManualActivityPanel } from "./manual-activity-panel";
import { type Range, RangeTabs, rangeSince } from "./range-tabs";
import { ValueDelta } from "./value-delta";
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
  specs,
  open,
  onOpenChange,
}: {
  account: AccountRow | null;
  total: number; // 活跃账户总计 —— 抽屉头占比分母(见 accounts.tsx)
  specs: InputSpec[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // key={account.id} 重挂 → 切账户自动清空 rename/confirm/range 等本地态。
  const body = account && (
    <DetailBody
      key={account.id}
      account={account}
      total={total}
      specs={specs}
      onClose={() => onOpenChange(false)}
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
  specs,
  onClose,
}: {
  account: AccountRow;
  total: number;
  specs: InputSpec[];
  onClose: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const router = useRouter();
  const refresh = () => router.invalidate();

  // 头部 24h 增量与账户行同源(缺凭据 → 不显增量);占比 = 本账户市值 / 活跃账户总计。
  const dayChange = account.needsCredentials ? null : aggregateDayChange(account.balances);
  const sharePct = accountShare(account.totalUsd, total) * 100;

  const archived = account.archivedAt != null;
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
      <div className="relative min-h-44 overflow-hidden">
        {series.length >= 2 && (
          <ValueTrendChart series={series} topMargin={56} fillOpacity={0.14} />
        )}

        {/* ⋯ 更多:同步 / 归档 / 删除(受控 open → 点选后关闭)。beUI Popover 组合,非 Radix。 */}
        <div className="absolute top-0 right-0 z-10">
          <Popover
            trigger="click"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            side="bottom"
            align="end"
            panelRadius={12}
          >
            <PopoverTrigger>
              <button
                type="button"
                aria-label={t("moreActions")}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex w-40 flex-col gap-0.5">
                <button
                  type="button"
                  className={menuItemClass}
                  disabled={archived || syncMut.isPending}
                  onClick={() => {
                    setMenuOpen(false);
                    syncMut.mutate();
                  }}
                >
                  <RefreshCw className="size-4 shrink-0" />
                  {t("syncThis")}
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  disabled={archiveMut.isPending}
                  onClick={() => {
                    setMenuOpen(false);
                    archiveMut.mutate();
                  }}
                >
                  <Archive className="size-4 shrink-0" />
                  {archived ? t("unarchive") : t("archive")}
                </button>
                <button
                  type="button"
                  className={cn(menuItemClass, "text-destructive hover:text-destructive")}
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="size-4 shrink-0" />
                  {tc("delete")}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* 窗口切换:右下角独占一带(与 asset-sheet 一致)。 */}
        <div className="absolute right-0 bottom-0 z-10">
          <RangeTabs value={range} onChange={setRange} />
        </div>

        <div className="relative flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
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
              // 点名字进入内联重命名;hover 名字浮出「点击重命名」tooltip + pencil。
              <span className="group relative inline-flex items-center">
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="inline-flex items-center gap-1.5 rounded-md text-left outline-none"
                >
                  <span className="font-normal font-serif text-xl">{account.label}</span>
                  <Pencil
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden
                  />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full left-0 mb-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-muted-foreground text-xs opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                >
                  {t("clickToRename")}
                </span>
              </span>
            )}
            {!renaming && <ConnectorBadge connectorId={account.connectorId} />}
            {!renaming && archived && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                {t("archivedBadge")}
              </span>
            )}
          </div>
          <ValueDelta
            align="left"
            value={account.totalUsd}
            delta={dayChange?.delta}
            pct={dayChange?.pct}
          />
          <p className="text-muted-foreground text-sm">
            {!archived && sharePct > 0 && `${t("shareOfTotal", { pct: shareLabel(sharePct) })} · `}
            {lastSynced}
          </p>
        </div>
      </div>

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

      {/* 缺凭据 → 补录(A3 会再 v2 化,此处保持可用) */}
      {account.needsCredentials && (
        <div className="mt-4">
          <p className="font-medium text-destructive text-sm">{t("provideCredentials")}</p>
          <CredentialForm
            accountId={account.id}
            specs={specs}
            hint={account.credsSafe}
            onDone={refresh}
          />
        </div>
      )}

      {/* 持仓(卡片列表)+ 带 provider 展示明细的持仓手风琴(per-balance) */}
      <div className="mt-6">
        <AccountHoldingsCards balances={account.balances} accountNote={account.note} />
      </div>

      {/* manual 活动(A5 会再 v2 化,此处保持可用) */}
      {account.connectorId === "manual" && (
        <div className="mt-6">
          <ManualActivityPanel accountId={account.id} />
        </div>
      )}
    </>
  );
}
