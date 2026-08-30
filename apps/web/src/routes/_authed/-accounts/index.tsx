import type { ConnectorId } from "@folio/connectors";
import { cn, SharedLayoutBg, Skeleton } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { AvatarStack } from "@/components/avatar-stack";
import { ConnectorBadge } from "@/components/connector-badge";
import { QueryBoundary } from "@/components/query-boundary";
import { TagBadges } from "@/components/tag-badges";
import { isManual } from "@/lib/core/manual";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useRelativeSyncedAt } from "@/lib/hooks/use-relative-synced-at";
import { useStalePriceRefresh } from "@/lib/hooks/use-stale-price-refresh";
import { accountHoldingsQuery, accountListQuery } from "@/lib/queries/accounts";
import { accountKeys } from "@/lib/queries/keys";
import {
  type AccountTagLinks,
  accountTagLinksQuery,
  type TagList,
  tagListQuery,
} from "@/lib/queries/tags";
import { type AccountSyncStatus, accountSyncStatus } from "@/lib/server/sync/status";
import { HeaderSync } from "@/routes/_authed/-home/header-sync";
import { GainSkeleton, ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";
import { AccountDetailSheet } from "./account-detail-sheet";
import { AddAccountModal, type CompleteTarget } from "./add-account-modal";
import {
  type AccountRow,
  accountShare,
  activeAccountsTotal,
  buildAccountRows,
  shareLabel,
  sortActiveAccounts,
} from "./list-rows";
import { accountStackItems } from "./list-stack-items";

const accountsRoute = getRouteApi("/_authed/accounts");

// 名单那一层的重试键。归属不再是独立一份数据(随账户行下发,ADR 0047),所以只剩账户列表这一条。
const LIST_RESET_KEY = (portfolioId: string) => JSON.stringify(accountKeys.list(portfolioId));

export function Accounts() {
  const t = useTranslations("Accounts");
  const { selectedId } = usePortfolio();
  const [addOpen, setAddOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null);
  const startComplete = (a: AccountRow) =>
    setCompleteTarget({ accountId: a.id, connectorId: a.connectorId, credsSafe: a.credsSafe });

  return (
    <div className="flex flex-col gap-6">
      {/* 页头右上角同步入口:账户页额外把「添加账户」融进 + 段(见 SyncStatus.ActionShell),modal 由本页持有。 */}
      <HeaderSync
        action={{ icon: <Plus />, label: t("addAccount"), onClick: () => setAddOpen(true) }}
      />
      <AddAccountModal
        open={addOpen}
        onOpenChange={setAddOpen}
        completeFor={completeTarget}
        onCompleteClose={() => setCompleteTarget(null)}
      />
      <QueryBoundary
        resetKey={`list:${LIST_RESET_KEY(selectedId)}`}
        pending={<ListSkeleton />}
        failed={<ListFailed />}
      >
        <AccountsList onComplete={startComplete} />
      </QueryBoundary>
    </div>
  );
}

function ListFailed() {
  const t = useTranslations("Overview");
  return <p className="py-12 text-center text-muted-foreground text-sm">{t("loadFailed")}</p>;
}

const ROWS_4 = ["r1", "r2", "r3", "r4"];

function ListSkeleton() {
  return (
    <>
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col">
        {ROWS_4.map((k) => (
          <div key={k} className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
              <span className="min-h-6" />
            </div>
            <div className="flex flex-col items-end gap-1">
              <Skeleton className="h-4 w-20" />
              <GainSkeleton />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// 账户名单。**账户行本身 + 归属**由外层边界等过;后到的是余额(含 24h 盈亏)、标签这两样。
//
// 后两样走**挂起 + 自己的边界**,不是 `useQuery` + `isPending`(原来的写法)。理由见
// `../-home/hero/index.tsx` 开头那段:那种写法在 SSR 上服务端有数据、客户端补水那一帧没有,
// 两边画的不是同一份 HTML,React 把整棵子树丢掉重渲。
//
// 24h 盈亏(FOL-51 起两端相减)**随持仓一起回**,不再是单独一条 —— `buildAccountRows` 直接把它
// 从持仓行带进 `AccountRow.gain24h`。`pending` 的兜底就是「同一份名单,金额与增量位是骨架」。
function AccountsList({ onComplete }: { onComplete: (a: AccountRow) => void }) {
  // **名单已经是当前组合那份**(ADR 0047:服务端按组合筛)—— 这一页不再拿全量账户 + 归属表自己筛。
  const { selectedId } = usePortfolio();
  const { data: accounts } = useSuspenseQuery(accountListQuery(selectedId));
  return (
    <QueryBoundary
      resetKey={`list-values:${JSON.stringify(accountKeys.holdings(selectedId))}`}
      pending={<AccountsListBody accounts={accounts} onComplete={onComplete} />}
      failed={<AccountsListBody accounts={accounts} onComplete={onComplete} />}
    >
      <AccountsListReady accounts={accounts} onComplete={onComplete} />
    </QueryBoundary>
  );
}

// 挂起点在这儿:余额(含盈亏)/ 标签都到了才渲染。
function AccountsListReady({
  accounts,
  onComplete,
}: {
  accounts: RowSources["accounts"];
  onComplete: (a: AccountRow) => void;
}) {
  const { selectedId } = usePortfolio();
  const { data: holdings } = useSuspenseQuery(accountHoldingsQuery(selectedId));
  const { data: allTags } = useSuspenseQuery(tagListQuery(selectedId));
  const { data: tagLinks } = useSuspenseQuery(accountTagLinksQuery(selectedId));
  return (
    <AccountsListBody
      accounts={accounts}
      onComplete={onComplete}
      holdings={holdings}
      allTags={allTags}
      tagLinks={tagLinks}
    />
  );
}

// 名单的形状**从被调用方推出来**,不另抄一份:抄一份的话它们迟早跟真的对不上。
type RowSources = Parameters<typeof buildAccountRows>[0];

function AccountsListBody({
  accounts,
  onComplete,
  holdings,
  allTags = [],
  tagLinks = [],
}: {
  accounts: RowSources["accounts"];
  onComplete: (a: AccountRow) => void;
  holdings?: RowSources["holdings"];
  // 这两样不取 `RowSources` 的:名单只要 id + 名字那一小片投影,而抽屉要的是整行。
  allTags?: TagList;
  tagLinks?: AccountTagLinks;
}) {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  // 盈亏已由 `buildAccountRows` 从持仓行带进各 `AccountRow`(FOL-51),不再另贴一层。
  const rows = useMemo(
    () => buildAccountRows({ accounts, holdings, allTags, tagLinks }),
    [accounts, holdings, allTags, tagLinks],
  );
  useStalePriceRefresh(holdings?.pricesStale, true);

  const allRows = rows;
  const activeUnsorted = rows.filter((r) => r.archivedAt == null);
  // 金额没到时别按假 0 排 —— 否则数字一到整表重排,看着像名单自己在跳。
  const active = activeUnsorted.every((r) => r.valuesReady)
    ? sortActiveAccounts(activeUnsorted)
    : activeUnsorted;
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows);

  const { account: selectedId, focus } = accountsRoute.useSearch();
  const navigate = accountsRoute.useNavigate();
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const setAccount = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, account: id }), replace: true, resetScroll: false });
  const openRow = (r: AccountRow) => setAccount(r.id);

  // 页头同步面板点了某一行 → 把它滚到视野中间,并短暗高亮一下(不改选中态:那看起来像选中了什么)。
  //
  // 面板的清单**已经按选中的 Portfolio 收口**(#530),所以点进来的账户必然就在这个列表里 ——
  // 这里不需要「先切到那个账户所属的组合」那一步(那段跨组合切换是它收口之前留下的死代码,
  // 随组合进 URL 一起删了)。找不到那一行只有一种情况:它归档了、或刚被删。
  //
  // 行还没渲染出来(刚从别的页面跳过来、数据在路上)时先不判:`allRows` 空就等下一轮,
  // 否则会把「还在加载」误当成「不在这个视图里」。
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || allRows.length === 0) return;
    const clearFocus = () =>
      navigate({
        search: (prev) => ({ ...prev, focus: undefined }),
        replace: true,
        resetScroll: false,
      });
    const el = document.getElementById(accountRowDomId(focus));
    if (el) {
      // 归档那些住在折叠的 <details> 里 —— 没展开就没有布局盒,scrollIntoView 会是个空操作。
      el.closest("details")?.setAttribute("open", "");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      setFlashId(focus);
    }
    clearFocus();
  }, [focus, allRows, navigate]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  return (
    <>
      <h1 className="font-bold text-2xl">{t("accountCount", { count: active.length })}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button
              key={r.id}
              id={accountRowDomId(r.id)}
              type="button"
              onClick={() => openRow(r)}
              className={cn(ROW_CLASS, flashId === r.id && FLASH_CLASS)}
            >
              <AccountRowContent row={r} total={total} onComplete={() => onComplete(r)} />
            </button>
          ))}
        </SharedLayoutBg>
      )}

      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("archivedSection", { count: archived.length })}
          </summary>
          <SharedLayoutBg className="mt-2" inset={0} pillClassName="rounded-xl bg-muted">
            {archived.map((r) => (
              <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
                <AccountRowContent row={r} total={total} muted />
              </button>
            ))}
          </SharedLayoutBg>
        </details>
      )}

      <AccountDetailSheet
        account={selected}
        total={total}
        allTags={allTags}
        tagLinks={tagLinks}
        open={selected != null}
        onOpenChange={(o) => {
          if (!o) setAccount(undefined);
        }}
        onComplete={onComplete}
      />
    </>
  );
}

const SEALED_DATE = { year: "2-digit", month: "short", day: "numeric" } as const;

function AccountStatusLine({
  status,
  takenAt,
  connectorId,
  archivedAt,
  onComplete,
}: {
  status: AccountSyncStatus;
  takenAt: number | null;
  connectorId: ConnectorId;
  archivedAt: number | null;
  onComplete?: () => void;
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  // 活时钟 + 钳位收在 hook 里(为什么不用裸 useNow 见 use-relative-synced-at)。
  const syncedAt = useRelativeSyncedAt();
  const archived = archivedAt != null;
  const warn = !archived && (status === "needsCreds" || status === "stale");
  const needsCreds = status === "needsCreds";
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs",
        warn ? "text-warn" : "text-muted-foreground",
      )}
    >
      {warn && (
        <>
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="sr-only">{t("syncWarning")}</span>
        </>
      )}
      {archived ? (
        t("sealedAt", { when: format.dateTime(new Date(archivedAt), SEALED_DATE) })
      ) : needsCreds && onComplete ? (
        // biome-ignore lint/a11y/useSemanticElements: 行本身是 <button>,不能再嵌套 <button>(无效 HTML),故用 role=button span
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onComplete();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onComplete();
            }
          }}
          className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-warn"
        >
          {t("completePrompt")}
        </span>
      ) : needsCreds ? (
        t("completePrompt")
      ) : isManual(connectorId) ? (
        t("liveValue")
      ) : takenAt != null ? (
        t("lastSyncedAt", { when: syncedAt(takenAt) })
      ) : (
        t("neverSynced")
      )}
    </span>
  );
}

const ROW_CLASS = "group w-full rounded-xl text-left";

// 滚到某一行之后那一下高亮。ring 而不是底色 —— SharedLayoutBg 的 hover/选中 pill 用的就是底色,
// 两者叠在一起分不出「被指出来」和「被选中」。
const FLASH_CLASS = "ring-2 ring-ring";
const FLASH_MS = 1200;

// 行的 DOM 锚。只有「从页头面板滚到这一行」用它,所以就近定义,不进公共模块。
const accountRowDomId = (accountId: string) => `account-row-${accountId}`;

// 必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的 z-10 div,
// 故 flex 布局放这层内层,避免竖排。归档行只调暗,不抽市值与叠标(#437)。
function AccountRowContent({
  row,
  total,
  muted,
  onComplete,
}: {
  row: AccountRow;
  total: number;
  muted?: boolean;
  onComplete?: () => void;
}) {
  const status = accountSyncStatus(row, Date.now());
  const archived = row.archivedAt != null;
  const showGain = !(row.needsCredentials || archived);
  const dayChange = showGain ? row.gain24h : undefined;
  const sharePct = accountShare(row.totalUsd, total) * 100;
  // 缺凭据 / 归档封存日 / manual「实时」名单里已经能确定,立刻写;其余同步时间等持仓到。
  const statusKnown =
    row.needsCredentials || archived || isManual(row.connectorId) || row.valuesReady;
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-xl px-3 py-3",
        muted && "opacity-60",
      )}
    >
      <span className="relative flex min-w-0 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{row.label}</span>
          <ConnectorBadge
            connectorId={row.connectorId}
            className="shrink-0 transition-colors group-hover:bg-background group-focus-visible:bg-background"
          />
          {row.tags.length > 0 && <TagBadges tags={row.tags} max={3} />}
        </span>
        {statusKnown ? (
          <AccountStatusLine
            status={status}
            takenAt={row.takenAt}
            connectorId={row.connectorId}
            archivedAt={row.archivedAt}
            onComplete={onComplete}
          />
        ) : (
          <Skeleton className="h-3 w-20" />
        )}
        <span className="flex min-h-6 items-center">
          <AvatarStack
            items={row.valuesReady ? accountStackItems(row.balances) : []}
            max={5}
            size="md"
          />
        </span>
      </span>
      <div className="relative shrink-0">
        {row.valuesReady && !archived && sharePct > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-full -z-10 -translate-y-1/2 translate-x-14 -rotate-12 whitespace-nowrap font-bold text-8xl text-background/50 leading-none tracking-tighter opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {shareLabel(sharePct)}%
          </span>
        )}
        {!row.valuesReady ? (
          <div className="flex flex-col items-end gap-1">
            <Skeleton className="h-4 w-20" />
            <GainSkeleton />
          </div>
        ) : (
          <ValueDelta
            value={row.totalUsd}
            delta={showGain ? (dayChange?.amount ?? null) : undefined}
            pct={dayChange?.pct}
          />
        )}
      </div>
    </div>
  );
}
