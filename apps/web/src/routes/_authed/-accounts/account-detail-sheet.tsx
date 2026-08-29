import type { AccountTagLink, Tag } from "@folio/db";
import {
  BottomSheet,
  Button,
  cn,
  Drawer,
  MorphingModal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  FolderInput,
  MoreVertical,
  RefreshCw,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AccountTagsModal } from "@/components/account-tags-modal";
import { AmountTicker } from "@/components/amount-ticker";
import { ConnectorBadge } from "@/components/connector-badge";
import { EditableName } from "@/components/editable-name";
import { AccountHoldingsCards } from "@/components/holdings-cards";
import { IconButton } from "@/components/icon-button";
import { ManualTokensPanel } from "@/components/manual-tokens-panel";
import { Portal } from "@/components/portal";
import { PortfolioPickerModal } from "@/components/portfolio-picker-modal";
import { type Range, RangeTabs, rangeSince } from "@/components/range-tabs";
import { TagBadges } from "@/components/tag-badges";
import { signedUsd } from "@/lib/core/format-number";
import { buildAccountValueHistory, type HistoryPoint } from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import type { Gain } from "@/lib/core/portfolio";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { accountHistoryQuery } from "@/lib/queries/accounts";
import { invalidateFor } from "@/lib/queries/refresh";
import { removeAccount, updateAccount } from "@/lib/server/accounts";
import { syncAccount } from "@/lib/server/sync";
import { TrendPanel } from "@/routes/_authed/-home/hero/trend-panel";
import { deltaTone, GainSkeleton, NO_VALUE } from "@/routes/_authed/-home/holdings/value-delta";
import { type AccountRow, accountShare, shareLabel } from "./list-rows";

// 账户详情抽屉(A2):桌面右滑 Drawer、移动 BottomSheet 承载同一份 <DetailBody>(照 token-sheet 模式)。
// 头部 = 账户价值历史图垫底 + 窗口切换 + ⋯ 菜单(同步/归档/删除);点名字内联重命名。全部持仓复用主页组件。
export function AccountDetailSheet({
  account,
  total,
  allTags,
  tagLinks,
  gainPending = false,
  open,
  onOpenChange,
  onComplete,
}: {
  account: AccountRow | null;
  total: number; // 活跃账户总计 —— 抽屉头占比分母(见 accounts.tsx)
  allTags: Tag[]; // 全部 Tag 定义(打标签弹窗按账户 Portfolio 过滤)
  tagLinks: AccountTagLink[]; // 全部 账户→Tag 关联(算已打 + 每 Tag 账户数)
  /** 24h 盈亏还在取 —— 抽屉头与现货行走小骨架,跟列表行同一个数。 */
  gainPending?: boolean;
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
      allTags={allTags}
      tagLinks={tagLinks}
      gainPending={gainPending}
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

// 封存日期的格式:与账户页那一行同款(2 位年 + 月 + 日),不带时分 —— 归档是「哪一天封的」这个粒度。
const SEALED_DATE = { year: "2-digit", month: "short", day: "numeric" } as const;

const menuItemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50";

function DetailBody({
  account,
  total,
  allTags,
  tagLinks,
  gainPending,
  onClose,
  onComplete,
}: {
  account: AccountRow;
  total: number;
  allTags: Tag[];
  tagLinks: AccountTagLink[];
  gainPending: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  // 活时钟 + 钳位收在 hook 里;抽屉是**晚挂载**的,正是那份注释里「等一跳才自愈」的受害者。
  const syncedAt = useRelativeSyncedAt();
  // 划动读数(#470 片7)。
  const scrub = useChartScrub();
  const writes = useAccountSheetWrites(account, onClose);

  const sealedAt = account.archivedAt;
  const archived = sealedAt != null;
  // 头部 24h 增量与账户行同源;占比 = 本账户市值 / 活跃账户总计。
  // **归档行两个都不显**(ADR 0039):市值冻在封存那一刻,而 24h 涨跌幅是富化带来的实时行情 ——
  // 一个停着一个在动,说的不是同一件事;占比的分母是活跃账户总计,归档不在里面,显示了会让
  // 各行的百分比加起来超过 100%。缺凭据不显增量是同一个道理。
  // 这两种是「**不该有**这个数」→ 整块省略;而「该有却**算不出**」是另一回事 → `—`。三态口径见
  // -home/holdings/value-delta,与行内 <ValueDelta> 共用 —— 这里字号不同(大字),故手搓而非复用组件。
  // 数由 server 算好(ADR 0040),与账户行同源 —— 抽屉头和列表行显示同一个数,不再各算各的。
  const hasDayChange = !(account.needsCredentials || archived);
  const dayChange = hasDayChange ? account.gain24h : undefined;
  const sharePct = accountShare(account.totalUsd, total) * 100;

  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  // 打标签弹窗的数据(ADR 0034):账户所在 Portfolio 的全部 Tag + 本账户已打 id + 每 Tag 账户数。
  const portfolioTags = useMemo(
    () => allTags.filter((tg) => tg.portfolioId === account.portfolioId),
    [allTags, account.portfolioId],
  );
  const attachedTagIds = useMemo(
    () => tagLinks.filter((l) => l.accountId === account.id).map((l) => l.tagId),
    [tagLinks, account.id],
  );
  const tagAccountCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of tagLinks) counts[l.tagId] = (counts[l.tagId] ?? 0) + 1;
    return counts;
  }, [tagLinks]);

  const [range, setRange] = useState<Range>("30d");
  const historyQuery = useQuery({
    ...accountHistoryQuery({
      accountId: account.id,
      range,
      // **归档账户的窗口从封存那一刻往回算**(ADR 0039)。用「现在」当锚点的话,一年前归档的账户
      // 在默认 30 天窗口下一个数据点都没有,图整个不渲染 —— 一个冻住的账户,「最近 30 天」本来
      // 就没有意义。锚在封存时刻之后,30D 读作「封存前 30 天」,窗口切换照常能用。
      since: rangeSince(range, sealedAt ?? Date.now()),
      connectorId: account.connectorId,
    }),
    placeholderData: keepPreviousData,
  });
  const raw = historyQuery.data;
  // 曲线在浏览器里画(FOL-38):接口发窗口内的原样快照点,阶梯重建 + 降采样在这儿。
  const series = useMemo(
    () => (raw == null ? [] : buildAccountValueHistory(raw.rows, raw.live)),
    [raw],
  );

  // **先判归档,再判是不是 manual**(ADR 0039):归档 = 封存,数据停在那一刻,所以显示的是
  // **静态日期**而不是相对时间 —— 相对时间会一天天长下去,看着像同步坏了。manual 那一支原本
  // 无条件显示「实时」,封存之后它显然不是,所以归档必须判在前面。
  const lastSynced =
    sealedAt != null
      ? t("sealedAt", { when: format.dateTime(new Date(sealedAt), SEALED_DATE) })
      : isManual(account.connectorId)
        ? t("liveValue")
        : account.takenAt
          ? t("lastSyncedAt", { when: syncedAt(account.takenAt) })
          : t("neverSynced");

  return (
    <>
      {/* 头部:价值历史图垫底;窗口切换叠右下角、⋯ 菜单叠右上角;名称/市值/占比浮其上。
          预留固定高度(min-h-44)→ 图异步到达不撑高、不挤压列表。 */}
      <div className="relative">
        <div className="relative min-h-44">
          <TrendPanel series={series} loading={historyQuery.isPending} onActive={scrub.onActive} />

          <div className="absolute right-0 bottom-0 z-10">
            <RangeTabs value={range} onChange={setRange} />
          </div>

          <div className="relative flex flex-col gap-1.5">
            {/* 就地重命名走全站统一的 EditableName;pr-10 给右上角 ⋯ 让位,名称不钻到按钮下。
                badge 作 children:展示态跟在名字后,编辑态自动隐藏。 */}
            <EditableName
              value={account.label}
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={async (name) => {
                await writes.renameMut.mutateAsync(name);
              }}
              displayClassName="font-semibold text-lg"
              className="pr-10"
            >
              <ConnectorBadge connectorId={account.connectorId} />
              {archived && (
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                  {t("archivedBadge")}
                </span>
              )}
              {/* Tag(#351):与 connector 徽章同排,muted 纯展示、**不可点** —— 编辑走 ⋯ 菜单里的「标签」。 */}
              <TagBadges tags={account.tags} />
            </EditableName>
            <div>
              <SheetHeaderValue
                valuesReady={account.valuesReady}
                totalUsd={account.totalUsd}
                hasDayChange={hasDayChange}
                gainPending={gainPending}
                dayChange={dayChange}
                scrubbed={scrub.point}
                scrubLabel={scrub.label}
              />
            </div>
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

        <SheetOverflowMenu
          connectorId={account.connectorId}
          archived={archived}
          syncPending={writes.syncMut.isPending}
          archivePending={writes.archiveMut.isPending}
          onSync={() => writes.syncMut.mutate()}
          onArchive={() => writes.archiveMut.mutate()}
          onTags={() => setTagsOpen(true)}
          onMove={() => setMoving(true)}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>

      <p className="mt-2 text-muted-foreground/30 text-xs">
        {account.valuesReady &&
          !archived &&
          sharePct > 0 &&
          `${t("shareOfTotal", { pct: shareLabel(sharePct) })} · `}
        {account.valuesReady ||
        account.needsCredentials ||
        archived ||
        isManual(account.connectorId) ? (
          lastSynced
        ) : (
          <Skeleton className="inline-block h-3 w-24" />
        )}
      </p>

      <ConfirmDeleteModal
        open={confirmDelete}
        pending={writes.deleteMut.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => writes.deleteMut.mutate()}
      />

      <PortfolioPickerModal
        mode="move"
        accountId={account.id}
        currentPortfolioId={account.portfolioId}
        open={moving}
        onClose={() => setMoving(false)}
      />

      <AccountTagsModal
        accountId={account.id}
        accountLabel={account.label}
        portfolioId={account.portfolioId}
        portfolioTags={portfolioTags}
        attachedTagIds={attachedTagIds}
        tagAccountCounts={tagAccountCounts}
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
      />

      <SheetHoldings account={account} gainPending={gainPending} />
    </>
  );
}

function useAccountSheetWrites(account: AccountRow, onClose: () => void) {
  const t = useTranslations("Accounts");
  const queryClient = useQueryClient();
  const archived = account.archivedAt != null;
  const refresh = () => invalidateFor(queryClient, "account.write");

  const syncMut = useMutation({
    mutationFn: () => syncAccount({ data: { accountId: account.id } }),
    onSuccess: async (r) => {
      if (r.ok) toast.success(t("synced", { count: 1 }));
      // 缺凭据也是「跳过」,但它是用户能修的那种(#527 裁定 2):以前和手记账户共用一个静默
      // 分支,点了同步屏幕上什么都不发生 —— 而唯一的下一步恰恰是「把凭据填完」。
      else if (r.skipped) {
        if (r.skipReason === "missing-credentials") toast.message(t("syncNeedsCredentials"));
      } else toast.error(r.error ?? t("syncGenericError"));
      await invalidateFor(queryClient, "account.sync");
    },
    onError: () => toast.error(t("syncGenericError")),
  });
  const archiveMut = useMutation({
    mutationFn: () => updateAccount({ data: { accountId: account.id, archived: !archived } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });
  const deleteMut = useMutation({
    mutationFn: () => removeAccount({ data: { accountId: account.id } }),
    onSuccess: async () => {
      onClose();
      await refresh();
    },
    onError: () => toast.error(t("actionFailed")),
  });
  // 改名走 mutateAsync:EditableName 靠 onSave 抛不抛来决定保不保住编辑态,
  // 而 mutateAsync 失败时会 reject —— 失败仍停在输入框里,用户接着改就行。
  const renameMut = useMutation({
    mutationFn: (label: string) => updateAccount({ data: { accountId: account.id, label } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });

  return { syncMut, archiveMut, deleteMut, renameMut };
}

function SheetOverflowMenu({
  connectorId,
  archived,
  syncPending,
  archivePending,
  onSync,
  onArchive,
  onTags,
  onMove,
  onDelete,
}: {
  connectorId: AccountRow["connectorId"];
  archived: boolean;
  syncPending: boolean;
  archivePending: boolean;
  onSync: () => void;
  onArchive: () => void;
  onTags: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const tp = useTranslations("Portfolio");
  const tt = useTranslations("Tags");
  const menuPop = useHoverPopover();

  return (
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
          <IconButton ref={menuPop.measureRef} aria-label={t("moreActions")}>
            <MoreVertical className="size-4" />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex w-40 flex-col gap-0.5">
            {!isManual(connectorId) && (
              <button
                type="button"
                className={menuItemClass}
                disabled={archived || syncPending}
                onClick={onSync}
              >
                <RefreshCw className="size-4 shrink-0" />
                {t("syncThis")}
              </button>
            )}
            <button
              type="button"
              className={menuItemClass}
              disabled={archivePending}
              onClick={onArchive}
            >
              <Archive className="size-4 shrink-0" />
              {archived ? t("unarchive") : t("archive")}
            </button>
            <button type="button" className={menuItemClass} onClick={onTags}>
              <TagIcon className="size-4 shrink-0" />
              {tt("menuAction")}
            </button>
            <button type="button" className={menuItemClass} onClick={onMove}>
              <FolderInput className="size-4 shrink-0" />
              {tp("moveTo")}
            </button>
            <button
              type="button"
              className={cn(menuItemClass, "text-destructive hover:text-destructive")}
              onClick={onDelete}
            >
              <Trash2 className="size-4 shrink-0" />
              {tc("delete")}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ConfirmDeleteModal({
  open,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const isDesktop = useMediaQuery("(min-width: 640px)");

  return (
    <Portal>
      <MorphingModal
        viewId={open ? "delete" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
        className="max-w-sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-foreground text-sm">{t("deleteConfirm")}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm} disabled={pending}>
              {pending ? tc("verifying") : t("deleteConfirmBtn")}
            </Button>
          </div>
        </div>
      </MorphingModal>
    </Portal>
  );
}

function SheetHeaderValue({
  valuesReady,
  totalUsd,
  hasDayChange,
  gainPending,
  dayChange,
  scrubbed,
  scrubLabel,
}: {
  valuesReady: boolean;
  totalUsd: number;
  hasDayChange: boolean;
  gainPending: boolean;
  dayChange: Gain | null | undefined;
  /** 正划在图上的那个点(#470 片7);`null` = 没在划,显示实时值。 */
  scrubbed: HistoryPoint | null;
  scrubLabel: string | null;
}) {
  const usd = useDisplayValue();
  if (!valuesReady) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-9 w-36" />
        <GainSkeleton />
      </div>
    );
  }
  // 划到图上某点 → 顶替成该点的值,24h 那行换成那一刻的时间:「今天涨跌」摆在一个历史时刻的
  // 数值旁边是两件事对不上。
  return (
    <>
      {/* 滚动与「整数/小数怎么拆」走 AmountTicker(hero、代币抽屉同一份);字号是这一处的事。 */}
      <AmountTicker
        value={scrubbed ? scrubbed.total : totalUsd}
        scrubbing={!!scrubbed}
        className="font-bold text-3xl"
        fractionClassName="font-bold text-muted-foreground text-xl tabular-nums"
      />
      {scrubLabel ? (
        <div className="mt-1 text-muted-foreground text-sm tabular-nums">{scrubLabel}</div>
      ) : null}
      {!scrubbed && hasDayChange && (
        <SheetHeaderGain gainPending={gainPending} dayChange={dayChange} usd={usd} />
      )}
    </>
  );
}

function SheetHeaderGain({
  gainPending,
  dayChange,
  usd,
}: {
  gainPending: boolean;
  dayChange: Gain | null | undefined;
  usd: (n: number) => string;
}) {
  if (gainPending) {
    return (
      <div className="mt-1">
        <GainSkeleton />
      </div>
    );
  }
  if (dayChange == null) {
    return <div className={cn("mt-1 text-sm tabular-nums", deltaTone(null))}>{NO_VALUE}</div>;
  }
  return (
    <div className={cn("mt-1 text-sm tabular-nums", deltaTone(dayChange.amount))}>
      {signedUsd(usd, dayChange.amount)}
      {dayChange.pct != null ? ` ${Math.abs(dayChange.pct).toFixed(2)}%` : ""}
    </div>
  );
}

function SheetHoldings({ account, gainPending }: { account: AccountRow; gainPending: boolean }) {
  if (!account.valuesReady) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  if (isManual(account.connectorId)) {
    return (
      <div className="mt-6">
        <ManualTokensPanel
          accountId={account.id}
          balances={account.balances}
          gainPending={gainPending}
        />
      </div>
    );
  }
  return (
    <div className="mt-6">
      <AccountHoldingsCards
        balances={account.balances}
        accountNote={account.note}
        gainPending={gainPending}
      />
    </div>
  );
}
