import type { ConnectorId } from "@folio/connectors";
import type { Note } from "@folio/connectors-basic";
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
import { AccountTagsModal } from "../../../components/account-tags-modal";
import { ConnectorBadge } from "../../../components/connector-badge";
import { EditableName } from "../../../components/editable-name";
import { AccountHoldingsCards } from "../../../components/holdings-cards";
import { IconButton } from "../../../components/icon-button";
import { ManualTokensPanel } from "../../../components/manual-tokens-panel";
import { Portal } from "../../../components/portal";
import { PortfolioPickerModal } from "../../../components/portfolio-picker-modal";
import { type Range, RangeTabs, rangeSince } from "../../../components/range-tabs";
import { TagBadges } from "../../../components/tag-badges";
import type { OverviewBalance } from "../../../lib/account-view";
import type { Gain } from "../../../lib/gain-24h";
import { useDisplayValue } from "../../../lib/hooks/use-display-value";
import { useHoverPopover } from "../../../lib/hooks/use-hover-popover";
import { isManual } from "../../../lib/manual-connector";
import { accountHistoryQuery } from "../../../lib/queries/accounts";
import { invalidateFor } from "../../../lib/queries/refresh";
import { removeAccount, updateAccount } from "../../../lib/server/accounts";
import { syncAccount } from "../../../lib/server/sync";
import { signedUsd } from "../../../lib/signed-usd";
import { TrendPanel } from "../-home/hero/trend-panel";
import { deltaTone, GainSkeleton, NO_VALUE } from "../-home/holdings/value-delta";
import { accountShare, shareLabel } from "./share";

// 账户页列表行的合并形状(listAccountHoldings ∪ listAccounts,见 accounts.tsx loader)。
export interface AccountRow {
  id: string;
  label: string;
  connectorId: ConnectorId;
  archivedAt: number | null;
  /** 持仓查询还没到(或失败还在重试)。金额/同步时间走骨架,不是 0 / 「从未同步」。 */
  valuesReady: boolean;
  totalUsd: number;
  takenAt: number | null;
  balances: OverviewBalance[]; // 各持仓自带 balance 级 note(note 重设计)
  // 24h 盈亏(ADR 0040),server 按快照历史 / 账本分段算好。`undefined` = 这个位置不该有(归档行);
  // `null` = 该有但算不出。账户行与抽屉头共用同一个数,不再各算各的。
  gain24h?: Gain | null;
  note?: Note[]; // account 级展示 note(Note[],整钱包;BTC 未确认/收款/派生分布)
  needsCredentials: boolean;
  credsSafe: Record<string, string>;
  portfolioId: string; // 账户所在 Portfolio(打标签弹窗按它取可选 Tag,ADR 0034)
  tags: AccountTagView[]; // 本账户已打的 Tag(展示用)
}

// 账户已打的 Tag 的展示投影(id + 名字;`#` 前缀只在渲染时贴,不入行)。
interface AccountTagView {
  id: string;
  name: string;
}

// 账户详情抽屉(A2):桌面右滑 Drawer、移动 BottomSheet 承载同一份 <DetailBody>(照 token-sheet 模式)。
// 头部 = 账户价值历史图垫底 + 窗口切换 + ⋯ 菜单(同步/归档/删除);点名字内联重命名。全部持仓复用主页组件。
export function AccountDetailSheet({
  account,
  total,
  allTags,
  tagLinks,
  open,
  onOpenChange,
  onComplete,
}: {
  account: AccountRow | null;
  total: number; // 活跃账户总计 —— 抽屉头占比分母(见 accounts.tsx)
  allTags: Tag[]; // 全部 Tag 定义(打标签弹窗按账户 Portfolio 过滤)
  tagLinks: AccountTagLink[]; // 全部 账户→Tag 关联(算已打 + 每 Tag 账户数)
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
  onClose,
  onComplete,
}: {
  account: AccountRow;
  total: number;
  allTags: Tag[];
  tagLinks: AccountTagLink[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const tp = useTranslations("Portfolio");
  const tt = useTranslations("Tags");
  const format = useFormatter();
  const usd = useDisplayValue();
  const queryClient = useQueryClient();
  // 改名 / 归档 / 删除同时改账户域与组合域(总额、走势)—— 映射表那一条两个前缀都列了。
  const refresh = () => invalidateFor(queryClient, "account.write");

  const sealedAt = account.archivedAt;
  const archived = sealedAt != null;
  // 头部 24h 增量与账户行同源;占比 = 本账户市值 / 活跃账户总计。
  // **归档行两个都不显**(ADR 0039):市值冻在封存那一刻,而 24h 涨跌幅是富化带来的实时行情 ——
  // 一个停着一个在动,说的不是同一件事;占比的分母是活跃账户总计,归档不在里面,显示了会让
  // 各行的百分比加起来超过 100%。缺凭据不显增量是同一个道理。
  // 这两种是「**不该有**这个数」→ 整块省略;而「该有却**算不出**」是另一回事 → `—`。三态口径见
  // -home/holdings/value-delta,与行内 <ValueDelta> 共用 —— 这里字号不同(大字),故手搓而非复用组件。
  // 数由 server 算好(ADR 0040),与账户行同源 —— 抽屉头和列表行显示同一个数,不再各算各的。
  const hasDayChange = !(account.needsCredentials || archived) && account.gain24h !== undefined;
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
  // 删除确认走 modal 的落位:桌面居中、手机贴底(同 AddAccountModal)。
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // ⋯ 菜单走全站统一的 hover popover 行为(关闭态隐 goo 垫底 → ghost 触发器不露 bg-popover 块;
  // 动态 side / 抬 z)。hover 触发,离开即收,不需受控关闭。
  const menuPop = useHoverPopover();

  // 头部背景 = 账户价值历史(窗口可切)。末点均与 account.totalUsd 同源 → 曲线当下点 ≡ 头部数值:
  // 非-manual 取最新快照冻结总额;manual 走账本 compute-on-read、由服务端补一个实时盯市末点(ADR 0018 / T5)。
  const [range, setRange] = useState<Range>("30d");
  const historyQuery = useQuery({
    ...accountHistoryQuery({
      accountId: account.id,
      range,
      // **归档账户的窗口从封存那一刻往回算**(ADR 0039)。用「现在」当锚点的话,一年前归档的账户
      // 在默认 30 天窗口下一个数据点都没有,图整个不渲染 —— 一个冻住的账户,「最近 30 天」本来
      // 就没有意义。锚在封存时刻之后,30D 读作「封存前 30 天」,窗口切换照常能用。
      since: rangeSince(range, account.archivedAt ?? Date.now()),
      connectorId: account.connectorId,
    }),
    placeholderData: keepPreviousData,
  });
  const series = historyQuery.data?.series ?? [];

  // 操作反馈统一走 toast(D07):同步给出成/败,写操作失败提示,成功以列表刷新为可见反馈。
  const syncMut = useMutation({
    mutationFn: () => syncAccount({ data: { accountId: account.id } }),
    onSuccess: async (r) => {
      if (r.ok) toast.success(t("synced", { count: 1 }));
      else if (!r.skipped) toast.error(r.error ?? t("syncGenericError"));
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
  // (mutate 不会 reject,换成它的话失败会静悄悄退出编辑,刚打的字就没了。)
  const renameMut = useMutation({
    mutationFn: (label: string) => updateAccount({ data: { accountId: account.id, label } }),
    onSuccess: refresh,
    onError: () => toast.error(t("actionFailed")),
  });

  // **先判归档,再判是不是 manual**(ADR 0039):归档 = 封存,数据停在那一刻,所以显示的是
  // **静态日期**而不是相对时间 —— 相对时间会一天天长下去,看着像同步坏了。manual 那一支原本
  // 无条件显示「实时」,封存之后它显然不是,所以归档必须判在前面。
  const lastSynced =
    sealedAt != null
      ? // 日期取归档时刻而不是最后一次同步的时刻 —— 见账户页那一处的同款注释。
        t("sealedAt", { when: format.dateTime(new Date(sealedAt), SEALED_DATE) })
      : isManual(account.connectorId)
        ? t("liveValue")
        : account.takenAt
          ? t("lastSyncedAt", { when: format.relativeTime(new Date(account.takenAt)) })
          : t("neverSynced");

  return (
    <>
      {/* 头部:价值历史图垫底;窗口切换叠右下角、⋯ 菜单叠右上角;名称/市值/占比浮其上。
          预留固定高度(min-h-44)→ 图异步到达不撑高、不挤压列表。 */}
      <div className="relative">
        <div className="relative min-h-44">
          <TrendPanel series={series} loading={historyQuery.isPending} />

          {/* 窗口切换:右下角独占一带(与 token-sheet 一致)。 */}
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
                await renameMut.mutateAsync(name);
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
            {/* 市值 + 24h 增量:字号同代币抽屉(值 text-3xl bold、增量 text-sm);缺凭据 → 无增量。
                金额没到也能点开抽屉(#493):头上的数字和下面持仓走骨架,不先画 0。 */}
            <div>
              {account.valuesReady ? (
                <>
                  <div className="font-bold text-3xl tabular-nums">{usd(account.totalUsd)}</div>
                  {hasDayChange &&
                    (dayChange == null ? (
                      <div className={cn("mt-1 text-sm tabular-nums", deltaTone(null))}>
                        {NO_VALUE}
                      </div>
                    ) : (
                      <div className={cn("mt-1 text-sm tabular-nums", deltaTone(dayChange.amount))}>
                        {signedUsd(usd, dayChange.amount)}
                        {dayChange.pct != null ? ` ${Math.abs(dayChange.pct).toFixed(2)}%` : ""}
                      </div>
                    ))}
                </>
              ) : (
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-9 w-36" />
                  <GainSkeleton />
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
              <IconButton ref={menuPop.measureRef} aria-label={t("moreActions")}>
                <MoreVertical className="size-4" />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex w-40 flex-col gap-0.5">
                {/* manual 不是同步源(ADR 0018)→ 不显「同步」项。 */}
                {!isManual(account.connectorId) && (
                  <button
                    type="button"
                    className={menuItemClass}
                    disabled={archived || syncMut.isPending}
                    onClick={() => syncMut.mutate()}
                  >
                    <RefreshCw className="size-4 shrink-0" />
                    {t("syncThis")}
                  </button>
                )}
                <button
                  type="button"
                  className={menuItemClass}
                  disabled={archiveMut.isPending}
                  onClick={() => archiveMut.mutate()}
                >
                  <Archive className="size-4 shrink-0" />
                  {archived ? t("unarchive") : t("archive")}
                </button>
                <button type="button" className={menuItemClass} onClick={() => setTagsOpen(true)}>
                  <TagIcon className="size-4 shrink-0" />
                  {tt("menuAction")}
                </button>
                <button type="button" className={menuItemClass} onClick={() => setMoving(true)}>
                  <FolderInput className="size-4 shrink-0" />
                  {tp("moveTo")}
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

      {/* 占比 + 同步时间:移到图下方,更小字体 + 更淡(次要信息,弱化)。金额没到时同步时间走骨架,
          缺凭据 / 归档 / manual 名单里已经能确定,照常写。 */}
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

      {/* 删除是破坏性操作 → 阻断式 modal 二次确认(取代原侧栏内联块,#165)。**必须 Portal 到 body**:
          详情侧栏(Drawer 的 aside / BottomSheet 的 drag 面板)带常驻 transform,会成为 fixed 后代的包含块,
          不 portal 出去 MorphingModal 的 fixed 铺不满视口、还会被侧栏 overflow 裁掉(见 portal.tsx)。
          MorphingModal 为 fixed z-[80],盖在侧栏(Drawer/BottomSheet 皆 z-50)之上;viewId=null 即关。 */}
      <Portal>
        <MorphingModal
          viewId={confirmDelete ? "delete" : null}
          onClose={() => setConfirmDelete(false)}
          placement={isDesktop ? "center" : "bottom"}
          className="max-w-sm"
        >
          <div className="flex flex-col gap-4">
            <p className="text-foreground text-sm">{t("deleteConfirm")}</p>
            <div className="flex justify-end gap-2">
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
        </MorphingModal>
      </Portal>

      {/* 移到 Portfolio(ADR 0033):列既有 + 新建一步归属。 */}
      <PortfolioPickerModal
        mode="move"
        accountId={account.id}
        open={moving}
        onClose={() => setMoving(false)}
      />

      {/* 打标签(ADR 0034):账户所在 Portfolio 的 Tag,点即生效 + 内联管理。 */}
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

      {/* manual 账户:多 token 面板(Tokens tab 已含持仓,故不再叠加上方持仓卡)。
          非-manual:持仓卡片列表 + provider 明细手风琴(缺凭据带导入快照 → 渲染陈旧持仓;无快照 → 内部空态)。
          金额没到 → 骨架,不把空数组画成「没有持仓」。 */}
      {account.valuesReady ? (
        isManual(account.connectorId) ? (
          <div className="mt-6">
            <ManualTokensPanel accountId={account.id} balances={account.balances} />
          </div>
        ) : (
          <div className="mt-6">
            <AccountHoldingsCards balances={account.balances} accountNote={account.note} />
          </div>
        )
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      )}
    </>
  );
}
