import type { ConnectorId } from "@folio/connectors";
import { cn, SharedLayoutBg } from "@folio/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { z } from "zod";
import { AccountDetailSheet, type AccountRow } from "../../components/account-detail-sheet";
import { AddAccountModal, type CompleteTarget } from "../../components/add-account-modal";
import { ConnectorBadge } from "../../components/connector-badge";
import { HeaderSync } from "../../components/header-sync";
import { AccountsSkeleton } from "../../components/skeletons";
import { TagBadges } from "../../components/tag-badges";
import { buildAccountRows } from "../../lib/account-rows";
import { accountShare, activeAccountsTotal, shareLabel } from "../../lib/account-share";
import { sortActiveAccounts } from "../../lib/account-sort";
import { accountStackItems } from "../../lib/account-stack-items";
import { type AccountSyncStatus, accountSyncStatus } from "../../lib/account-sync-status";
import { accountIdsInView } from "../../lib/accounts-in-view";
import { usePortfolio } from "../../lib/hooks/use-portfolio";
import { useStalePriceRefresh } from "../../lib/hooks/use-stale-price-refresh";
import { isManual } from "../../lib/manual-connector";
import { accountHoldingsQuery, accountListQuery } from "../../lib/queries/accounts";
import { connectorCatalogQuery } from "../../lib/queries/connectors";
import { portfolioMembershipsQuery } from "../../lib/queries/portfolio";
import { accountTagLinksQuery, tagListQuery } from "../../lib/queries/tags";
import { AvatarStack, ValueDelta } from "./-home/holdings";

export const Route = createFileRoute("/_authed/accounts")({
  // 详情抽屉进 URL(与首页主 tab 同一套,ADR 0043):刷新还停在这个账户、链接能分享。
  // **只校验形状,不校验值** —— 账户 id 是运行时数据(还可能指向已删/不在当前 Portfolio 的账户),
  // 认不出的由组件当作没开,见下面的 `selected`。
  //
  // `.catch(undefined)` 不是装饰:schema 一旦抛错,router 就把它当路由错误,整页变成
  // 「Something went wrong!」外加一坨 zod 报错 JSON。实测(去掉 `.catch` 复现):`?account=`
  // 空串触发 `too_small`,`?account=a&account=b` 被解析成数组触发 `invalid_type` —— 两个都只是
  // 地址栏里敲坏了一个参数,不该把页面打没。`.catch` 把它们收成「没带这个参数」。
  validateSearch: z.object({ account: z.string().min(1).optional().catch(undefined) }),
  // 账户域的读取已迁 react-query(#413):loader 只**预取**,拼行的活挪进组件 —— 四个来源现在
  // 各自是一条查询、各自的到达时刻不同,拼装得跟着数据走而不是跟着 loader 走。
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      // connector 展示名的目录:**本页每一行都有一个徽标**,不预取的话首帧只能显兜底名(#467)。
      // 部署内静态、缓存一次,所以这一条实际只在整个会话的第一次加载上花一趟(与其余几条并行)。
      queryClient.ensureQueryData(connectorCatalogQuery()),
      queryClient.ensureQueryData(accountHoldingsQuery()),
      queryClient.ensureQueryData(accountListQuery()),
      queryClient.ensureQueryData(portfolioMembershipsQuery()),
      queryClient.ensureQueryData(tagListQuery()),
      queryClient.ensureQueryData(accountTagLinksQuery()),
    ]);
  },
  pendingComponent: AccountsSkeleton,
  component: Accounts,
});

function Accounts() {
  const t = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const { data: allTags } = useSuspenseQuery(tagListQuery());
  const { data: tagLinks } = useSuspenseQuery(accountTagLinksQuery());
  const { data: accounts } = useSuspenseQuery(accountListQuery());
  const { data: holdings } = useSuspenseQuery(accountHoldingsQuery());
  const { data: memberships } = useSuspenseQuery(portfolioMembershipsQuery());
  const allRows = useMemo(
    () => buildAccountRows({ accounts, holdings, memberships, allTags, tagLinks }),
    [accounts, holdings, memberships, allTags, tagLinks],
  );
  const pricesStale = holdings.pricesStale;
  const { selectedId: selectedPortfolioId, defaultId } = usePortfolio();
  useStalePriceRefresh(pricesStale); // SWR:先展示旧价,后台刷新后 invalidate 二次展示

  // 账户页 scope 到选中 Portfolio(ADR 0033):只显归属选中的账户(含其归档成员)。归属过滤在客户端
  // (归档无关的成员集),切 Portfolio 即时重筛、无需重拉。选择器即作用域,账户页不设单独 tab。
  const memberIds = accountIdsInView(
    allRows.map((r) => r.id),
    memberships,
    selectedPortfolioId,
    defaultId,
  );
  const rows = allRows.filter((r) => memberIds.has(r.id));

  // 活跃账户排序:未同步过(新加)置顶 → 其余按市值倒序;归档在末尾独立分区。
  const active = sortActiveAccounts(rows.filter((r) => r.archivedAt == null));
  const archived = rows.filter((r) => r.archivedAt != null);
  const total = activeAccountsTotal(rows); // 抽屉占比分母(顶部不显总额)

  // 详情侧栏**住在 URL 里**(ADR 0043),存 id 而非行对象 —— invalidate 后从新 rows 派生,
  // 侧栏内容随刷新自动更新(归档态等)。认不出的 id(账户已删、或不在当前 Portfolio 的作用域内,
  // 上面按 memberIds 筛过)→ 找不到就是没开。
  const { account: selectedId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  // 补录目标(A3):列表/详情点补录 icon → 开加账户 modal 的补录模式(见 AddAccountModal completeFor)。
  const [completeTarget, setCompleteTarget] = useState<CompleteTarget | null>(null);
  const selected = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  // `replace` + `resetScroll: false` 与主 tab 一致:开合抽屉不进后退栈,也不把身后的列表弹回顶部。
  const setAccount = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, account: id }), replace: true, resetScroll: false });
  const openRow = (r: AccountRow) => setAccount(r.id);
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
      <h1 className="font-bold text-2xl">{t("accountCount", { count: active.length })}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{tc("noAccountsYet")}</p>
      ) : (
        <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
          {active.map((r) => (
            <button key={r.id} type="button" onClick={() => openRow(r)} className={ROW_CLASS}>
              <AccountRowContent row={r} total={total} onComplete={() => startComplete(r)} />
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
        onComplete={startComplete}
      />
    </div>
  );
}

// 封存日期的格式:与手记活动弹窗那处的日期同款(2 位年 + 月 + 日),不带时分 ——
// 归档是「哪一天封的」这个粒度,精确到秒没有意义。
const SEALED_DATE = { year: "2-digit", month: "short", day: "numeric" } as const;

// 状态行(名称下方一条纯文本,按态染色):缺凭据 / 陈旧 → --warn 警示色 + 前置 ⚠;新鲜 / 从未同步 → muted。
// 缺凭据 → 显可点击的"补填凭据以同步"提示(文案即入口,点开补录 modal);陈旧显"同步于 {when}"。派生走 accountSyncStatus。
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
  onComplete?: () => void; // 缺凭据时:点提示文案开补录 modal(A3),不冒泡到行的打开详情
}) {
  const t = useTranslations("Accounts");
  const format = useFormatter();
  const archived = archivedAt != null;
  // 归档行永远不警示:它按设计就是停更的,再画个⚠说「同步陈旧」是在报一个不存在的故障。
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
      {/* 缺凭据 + 可补录 → 可点击提示文案(文案本身即入口);行是 <button>,故用 role=button span +
          stopPropagation 避免按钮套按钮 / 误触打开详情。归档(无 onComplete)→ 纯文案。 */}
      {archived ? (
        // 归档 = 封存(ADR 0039):**先判归档,再判是不是 manual**。
        // 时间是静态日期,不是相对时间 —— 归档账户的时间戳永远不动,相对时间会一天天长下去。
        // manual 归档账户尤其要走这条:它那一支原本无条件显示「实时」,而封存之后它显然不是。
        // **日期取 `archivedAt`,不是 `takenAt`。** 后者是最后一次同步的时刻 —— 一个 1 月同步、
        // 3 月才归档的账户会被写成「封存于 1 月」,而它其实是 3 月封的。数据有多旧另说,
        // 这句话说的是「什么时候封的」。
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
        // manual 不同步,当下值实时由 creds 现造(ADR 0018)→ 显「实时」而非同步时间。
        t("liveValue")
      ) : takenAt != null ? (
        t("lastSyncedAt", { when: format.relativeTime(new Date(takenAt)) })
      ) : (
        t("neverSynced")
      )}
    </span>
  );
}

// 行按钮 className:hover 高亮交给 SharedLayoutBg 的移动 pill 承载(行间无分隔线/边框),与代币行一致。
// group:让行内徽章/占比底衬能按 group-hover 响应 hover。padding 放内容层(见 AccountRowContent),
// 按钮本身不裁剪 —— 否则会切掉 SharedLayoutBg 的跨行滑块动画。
const ROW_CLASS = "group w-full rounded-xl text-left";

// 单个账户行内容:名称 + Platform 徽章 / 状态行 / 持有代币叠标;右侧市值 + 24h 增量(<ValueDelta> 全站统一,
// 与代币行同款)。缺凭据 → 不显增量(不再同步,无新鲜变化);占比只在抽屉里显示。
// 必须是单个 flex 容器 —— SharedLayoutBg 会把 <button> 的 children 塞进一个非 flex 的 z-10 div(见其实现),
// 故 flex 布局放这层内层 div,避免竖排(与 token-holdings RowContent 同约束)。
function AccountRowContent({
  row,
  total,
  muted,
  onComplete,
}: {
  row: AccountRow;
  total: number;
  /** 归档行:**只调暗,不抽内容**。原来它顺手把市值与持仓叠标一起隐了 —— 而「归档后仍看得见
   *  归档前的持仓」正是 #437 要的东西,藏起来等于这件事只在抽屉里成立。 */
  muted?: boolean;
  onComplete?: () => void; // 活跃缺凭据行:行内补录按钮(归档行不传)
}) {
  const status = accountSyncStatus(row, Date.now());
  const archived = row.archivedAt != null;
  // 24h 盈亏(ADR 0040)由 server 算好 —— 以前是在这里拿市场涨跌幅逐行倒推再加起来。
  // 归档 = 封存:市值冻在那一刻,「今天涨了多少」对一个停住的数字无从谈起(server 那侧已给 undefined)。
  // 缺凭据同理:不再同步,没有新鲜变化可言。这两种是「不该有这个数」→ 整行省略;
  // 而**该有却算不出**是另一回事 → `—`,见 ValueDelta 的三态。
  const hasDayChange = !(row.needsCredentials || archived) && row.gain24h !== undefined;
  const dayChange = hasDayChange ? row.gain24h : undefined;
  // 占比的分母是活跃账户总计,归档不在里面 —— 显示了就是「不属于这个总数、却给了个百分比」,
  // 各行加起来还会超过 100%。
  const sharePct = accountShare(row.totalUsd, total) * 100;
  return (
    // padding + overflow-hidden 放这层(填满整行):占比大字只被行外框裁,不在内容盒内被切。
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-xl px-3 py-3",
        muted && "opacity-60",
      )}
    >
      <span className="relative flex min-w-0 flex-col gap-1.5">
        {/* 第一行:账户名 + connector 徽章 + Tag(#351:tag 从独立一行挪到这里)。地方不够时**账户名先截断**
            (min-w-0 + truncate 只挂它),connector/tag 保持完整;tag 仍最多平铺 2 个、余下折 `+N`。 */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{row.label}</span>
          <ConnectorBadge
            connectorId={row.connectorId}
            className="shrink-0 transition-colors group-hover:bg-background group-focus-visible:bg-background"
          />
          {/* max=3:3 个以内全平铺,超过 3 个显 2 个 + `+N`(尾巴自己占一格)。
              不加 shrink-0:那会让每个 tag 上的 truncate 永远用不上,长名字被行的 overflow-hidden
              齐腰切掉;能缩才会走省略号。名字仍先截断(它在同一行里更早让位)。 */}
          {row.tags.length > 0 && <TagBadges tags={row.tags} max={3} />}
        </span>
        <AccountStatusLine
          status={status}
          takenAt={row.takenAt}
          connectorId={row.connectorId}
          archivedAt={row.archivedAt}
          onComplete={onComplete}
        />
        {/* 叠标位始终预留行高(min-h-6 = 叠标头像高),什么都没有的行(从未同步)也不塌矮,
            全列表行高一致。三类持仓都进这一排(现货币 / 永续标的 / DeFi 协议,见 accountStackItems)。
            一格都没有时 <AvatarStack> 自己什么都不画,外面这个 span 仍占着高度。 */}
        <span className="flex min-h-6 items-center">
          <AvatarStack items={accountStackItems(row.balances)} max={5} size="md" />
        </span>
      </span>
      <div className="relative shrink-0">
        {/* hover 底衬:超大占比数字倾斜、占满行高,锚在价值左缘(right-full)再右移一个 % 宽度 —— 只有末尾 %
              掖进价值下、前面数字全露出;-z-10 垫在名称/价值之下,中性淡色、仅 hover 浮现、不可点、不参与朗读。 */}
        {!archived && sharePct > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-full -z-10 -translate-y-1/2 translate-x-14 -rotate-12 whitespace-nowrap font-bold text-8xl text-background/50 leading-none tracking-tighter opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {shareLabel(sharePct)}%
          </span>
        )}
        <ValueDelta
          value={row.totalUsd}
          delta={hasDayChange ? (dayChange?.amount ?? null) : undefined}
          pct={dayChange?.pct}
        />
      </div>
    </div>
  );
}
