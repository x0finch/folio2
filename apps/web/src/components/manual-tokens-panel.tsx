import type { ManualActivity } from "@folio/db";
import {
  Button,
  LogoAvatar,
  MorphingModal,
  type SwipeAction,
  SwipeableList,
  type SwipeableListClassNames,
  type SwipeableListItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useMediaQuery,
} from "@folio/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { OverviewBalance } from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { useLocalDateFormat } from "../lib/hooks/use-local-date-format";
import {
  accountTotalAt,
  type HistoryActivity,
  type HistoryToken,
  isReduceOversold,
} from "../lib/manual-history";
import type { ActivityDraft, PickedToken } from "../lib/manual-types";
import { manualAccountQuery } from "../lib/queries/accounts";
import { invalidateFor } from "../lib/queries/refresh";
import {
  createManualActivities,
  removeManualActivity,
  updateManualActivity,
} from "../lib/server/manual-activities";
import { removeManualToken } from "../lib/server/manual-tokens";
import type { TokenOption } from "../lib/token-option";
import { buildOwnedOptions } from "../lib/token-search";
import { TokenRowContent } from "../routes/_authed/-home/holdings";
import { HoverDetail } from "./hover-detail";
import {
  type ActivityPatch,
  type EditActivityInput,
  ManualActivityModal,
  type SubmitResult,
} from "./manual-activity-modal";
import { Portal } from "./portal";

// manual 账户详情抽屉的多 token 面板(A5 F → T4:接服务端)。Tokens|Activity 双 tab(全圆 pill,默认 Tokens)+
// tab 行右 ghost plus(一律开 Add activity)。两个 SwipeableList 去卡片(surface = 抽屉底色平铺 + hover:bg-muted,
// 与主页 SharedLayoutBg 药丸同色);Tokens 复用主页 <TokenRowContent>。token 行 swipe:编辑=开 Add activity 并锁定该
// token(记一笔 set 校准)、删除=确认 modal;activity 行 swipe:编辑=预填 modal、删除=确认 modal。
// 数据由 getManualAccountDetail 现读(token + 活动账本),写走 T3 server fn,成功后失效明细查询 + router 刷新(真持久)。

const kindTone: Record<string, string> = {
  add: "text-pos",
  reduce: "text-neg",
  set: "text-muted-foreground",
};

// swipe 行去卡片:surface 用抽屉底色 bg-background(不透明遮住滑出前的操作轨);flex items-center 垂直居中;
// min-h-[68px](= 主页代币行高)让 Tokens 与 Activity 两列表行高一致;hover:bg-muted 给悬停反馈。
const flatSwipe: SwipeableListClassNames = {
  item: "rounded-xl bg-background",
  surface:
    "flex min-h-[68px] items-center rounded-xl border-0 bg-background px-3 py-2.5 shadow-none transition-colors hover:bg-muted",
  action: "[&>span]:group-hover:bg-muted!",
};

// 账本活动 + 展示用 symbol/logo(logo 自 balances 富化,缺则用 symbol 首字母)。
interface ActivityRow extends ManualActivity {
  symbol: string;
  logo?: string;
}

// 活动时间按本地时区展示(见 useLocalDateFormat)。列表行只显日期;hover 明细显日期 + 时间(到秒)。
const LIST_DATE_FMT = { dateStyle: "medium" } as const;
const DETAIL_DATETIME_FMT = { dateStyle: "medium", timeStyle: "medium" } as const;

export function ManualTokensPanel({
  accountId,
  balances,
}: {
  accountId: string;
  balances: OverviewBalance[];
}) {
  const t = useTranslations("Activity");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const queryClient = useQueryClient();

  const dateFmt = useLocalDateFormat(LIST_DATE_FMT);
  const dateTimeFmt = useLocalDateFormat(DETAIL_DATETIME_FMT);

  const detailQuery = useQuery(manualAccountQuery(accountId));
  const tokens = useMemo(() => detailQuery.data?.tokens ?? [], [detailQuery.data]);
  const activities = useMemo(() => detailQuery.data?.activities ?? [], [detailQuery.data]);

  // balances(overview,实时富化)提供 logo/name/实时市值;按大写 symbol 匹配账本 token(账本只出事实数量/单价/标识)。
  const balBySymbol = useMemo(
    () => new Map(balances.map((b) => [(b.symbol ?? "").toUpperCase(), b])),
    [balances],
  );
  const tokenById = useMemo(() => new Map(tokens.map((tk) => [tk.id, tk])), [tokens]);

  // 选币「已有代币」组(#269):这个侧边栏账户账本里的持仓 → 可选中项。逻辑在 buildOwnedOptions
  //(纯,含测):只收有票的,不看余额(已清仓的旧持仓也留着)。
  const ownedOptions = useMemo<TokenOption[]>(
    () => buildOwnedOptions(tokens, balBySymbol),
    [tokens, balBySymbol],
  );

  const pickedTokenOf = (tk: (typeof tokens)[number]): PickedToken => {
    const bal = balBySymbol.get(tk.symbol.toUpperCase());
    return {
      symbol: tk.symbol,
      ticket: tk.ticket ?? undefined,
      logo: bal?.logo,
      name: bal?.name,
      unitPrice: tk.unitPrice ?? 0, // 0 = 没声明过
    };
  };

  // 合并账本(跨 token,新→旧),附展示 symbol/logo。
  const merged = useMemo<ActivityRow[]>(() => {
    return [...activities]
      .sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt)
      .map((a) => {
        const tk = a.tokenId ? tokenById.get(a.tokenId) : undefined;
        const symbol = tk?.symbol ?? "?";
        return { ...a, symbol, logo: balBySymbol.get(symbol.toUpperCase())?.logo };
      });
  }, [activities, tokenById, balBySymbol]);

  // 活动明细「此时账户总额」+ 卖超提示的纯逻辑输入:全 token 的账本(compute-on-read,无 oracle 注入 → 走账本价②③)。
  const historyTokens = useMemo<HistoryToken[]>(
    () =>
      tokens.map((tk) => ({
        id: tk.id,
        unitPrice: tk.unitPrice ?? 0,
        recognized: tk.ticket != null,
        activities: activities
          .filter((a) => a.tokenId === tk.id)
          .map((a) => ({
            kind: a.kind,
            amount: a.amount,
            occurredAt: a.occurredAt,
            createdAt: a.createdAt,
            price: a.price,
          })),
      })),
    [tokens, activities],
  );
  const actsByToken = useMemo(() => {
    const m = new Map<string, HistoryActivity[]>();
    for (const a of activities) {
      if (!a.tokenId) continue;
      const arr = m.get(a.tokenId) ?? [];
      arr.push({
        kind: a.kind,
        amount: a.amount,
        occurredAt: a.occurredAt,
        createdAt: a.createdAt,
        price: a.price,
      });
      m.set(a.tokenId, arr);
    }
    return m;
  }, [activities]);

  const [tab, setTab] = useState("tokens");
  const [activity, setActivity] = useState<{
    open: boolean;
    token: PickedToken | null;
    lock: boolean;
    edit: EditActivityInput | null;
  }>({ open: false, token: null, lock: false, edit: null });
  const [confirm, setConfirm] = useState<{ title: string; onConfirm: () => void } | null>(null);

  const closeActivity = () => setActivity((s) => ({ ...s, open: false }));

  // 写后刷新:一句就够。手记明细那条查询住在账户域前缀之下,`account.write` 顺带盖住它 ——
  // 以前要「明细 + 整页」两句,是因为整页那句根本碰不到 react-query 缓存。
  const refresh = () => invalidateFor(queryClient, "account.write");

  const removeTokenMut = useMutation({
    mutationFn: (tokenId: string) => removeManualToken({ data: { accountId, tokenId } }),
    onSuccess: refresh,
    onError: () => toast.error(ta("actionFailed")),
  });
  const removeActivityMut = useMutation({
    mutationFn: (activityId: string) => removeManualActivity({ data: { accountId, activityId } }),
    onSuccess: refresh,
    onError: () => toast.error(ta("actionFailed")),
  });

  // 活动的新增 / 编辑。这两条与上面两条删除不同的地方:**它们有一种「服务端好好地拒绝了你」**——
  // 卖超时返回 `{ ok: false }`,不是抛错。所以 onSuccess 里还要再分一次岔:
  // 只有 `ok` 才刷新 + 关窗,`ok === false` 保持弹窗开着,让用户就地改数字。
  //
  // 失败提示走弹窗内部(`submitResult`)而不是 toast —— 用户此刻眼睛在弹窗上,
  // 而 toast 在 modal 之下,报了也白报。上面两条删除没有弹窗,所以照旧 toast。
  const addActivitiesMut = useMutation({
    mutationFn: (drafts: ActivityDraft[]) =>
      createManualActivities({
        data: {
          accountId,
          drafts: drafts.map((d) => ({
            token: {
              symbol: d.token.symbol,
              unitPrice: d.token.unitPrice,
              ticket: d.token.ticket ?? null,
            },
            kind: d.kind,
            amount: d.amount,
            occurredAt: d.occurredAt,
            price: d.price ?? null,
            fee: d.fee ?? null,
            memo: d.memo ?? null,
          })),
        },
      }),
    onSuccess: async (res) => {
      if (!res.ok) return; // 卖超:弹窗留着报原因
      await refresh();
      closeActivity();
      setTab("activity");
    },
  });
  const editActivityMut = useMutation({
    mutationFn: ({ activityId, patch }: { activityId: string; patch: ActivityPatch }) =>
      updateManualActivity({
        data: {
          activityId,
          patch: {
            kind: patch.kind,
            amount: patch.amount,
            occurredAt: patch.occurredAt,
            price: patch.price ?? null,
            fee: patch.fee ?? null,
            memo: patch.memo ?? null,
          },
        },
      }),
    onSuccess: async (res) => {
      if (!res.ok) return;
      await refresh();
      closeActivity();
    },
  });
  const activityPending = addActivitiesMut.isPending || editActivityMut.isPending;
  const activitySubmitResult: SubmitResult =
    addActivitiesMut.isError || editActivityMut.isError
      ? "failed"
      : addActivitiesMut.data?.ok === false || editActivityMut.data?.ok === false
        ? "over"
        : null;

  // 默认选中最新一笔活动的 token(供 plus 预选)。
  const latest = merged[0];
  const latestTokenRow = latest?.tokenId ? tokenById.get(latest.tokenId) : undefined;
  const latestToken = latestTokenRow ? pickedTokenOf(latestTokenRow) : null;

  // 每次开弹窗都把两条 mutation 的结果清掉。mutation 的状态活在组件上、不随弹窗卸载而消失,
  // 不清的话上一轮的「卖超」红字会原样出现在下一次打开的空表单里。
  const openActivity = (next: Omit<typeof activity, "open">) => {
    addActivitiesMut.reset();
    editActivityMut.reset();
    setActivity({ ...next, open: true });
  };

  const openPlus = () => openActivity({ token: latestToken, lock: false, edit: null });
  const openTokenEdit = (tk: (typeof tokens)[number]) =>
    openActivity({ token: pickedTokenOf(tk), lock: true, edit: null });
  // 活动行「编辑」:锁定该 token,预填这笔活动的全部字段(kind/数量/单价/手续费/日期/备注)。
  const openActivityEdit = (a: ActivityRow) => {
    const tk = a.tokenId ? tokenById.get(a.tokenId) : undefined;
    const token = tk ? pickedTokenOf(tk) : { symbol: a.symbol, logo: a.logo, unitPrice: 0 };
    openActivity({
      token,
      lock: true,
      edit: {
        tokenId: a.tokenId ?? "",
        activityId: a.id,
        token,
        kind: a.kind,
        amount: a.amount,
        price: a.price ?? undefined,
        fee: a.fee ?? undefined,
        occurredAt: a.occurredAt,
        memo: a.memo ?? undefined,
      },
    });
  };

  const tokenItems: SwipeableListItem[] = tokens.map((tk) => {
    const bal = balBySymbol.get(tk.symbol.toUpperCase());
    // 市值:优先 balances 实时市值(与抽屉头/首页同源);缺则回退 数量 × 单价。
    const value = bal ? bal.usdValue : tk.amount * (tk.unitPrice ?? 0);
    const rightActions: SwipeAction[] = [
      {
        id: "edit",
        label: t("addActivityTitle"),
        icon: <Pencil className="size-4" />,
        tone: "neutral",
        onClick: () => openTokenEdit(tk),
      },
      {
        id: "delete",
        label: tc("delete"),
        icon: <Trash2 className="size-4" />,
        tone: "neutral",
        onClick: () =>
          setConfirm({
            title: t("confirmDeleteToken", { symbol: tk.symbol.toUpperCase() }),
            onConfirm: () => removeTokenMut.mutate(tk.id),
          }),
      },
    ];
    return {
      id: tk.id,
      content: (
        <TokenRowContent
          item={{
            logo: bal?.logo,
            name: bal?.name ?? tk.symbol.toUpperCase(),
            symbol: tk.symbol.toUpperCase(),
            amount: tk.amount,
            value,
            // 24h 盈亏(ADR 0040):与抽屉头 / 首页同源的那个数。**别漏** —— 漏了 `TokenRowContent`
            // 收到 undefined,整行静默不渲染增量,看起来像「手记账户没有这个功能」。
            gain24h: bal?.gain24h,
          }}
        />
      ),
      rightActions,
    };
  });

  const activityItems: SwipeableListItem[] = merged.map((a) => {
    // 卖超(reduce 超过当时持有):行内在数量·symbol 后挂 warning icon + 明细里如实提示(不改折叠结果)。
    const oversold = a.tokenId ? isReduceOversold(actsByToken.get(a.tokenId) ?? [], a) : false;
    return {
      id: a.id,
      rightActions: [
        {
          id: "edit",
          label: t("editActivityTitle"),
          icon: <Pencil className="size-4" />,
          tone: "neutral",
          onClick: () => openActivityEdit(a),
        },
        {
          id: "delete",
          label: tc("delete"),
          icon: <Trash2 className="size-4" />,
          tone: "neutral",
          onClick: () =>
            setConfirm({
              title: t("confirmDeleteActivity"),
              onConfirm: () => removeActivityMut.mutate(a.id),
            }),
        },
      ],
      // 字体与 <TokenRowContent> 同位对齐:第一行 = 名称位(font-medium 基号)、第二行 = 数量·symbol 位(text-xs)。
      content: (
        <div className="flex w-full items-center gap-3">
          <LogoAvatar src={a.logo} fallback={a.symbol} size="md" />
          <div className="min-w-0 flex-1">
            <div className="min-w-0 truncate font-medium tabular-nums">
              <HoverDetail
                className="inline underline-offset-4 decoration-muted-foreground/60 hover:underline"
                detail={
                  <ActivityDetail
                    row={a}
                    totalThen={accountTotalAt(historyTokens, a.occurredAt)}
                    oversold={oversold}
                    t={t}
                    format={format}
                    dateTimeFmt={dateTimeFmt}
                  />
                }
              >
                {formatNumber(a.amount)} {a.symbol.toUpperCase()}
                {/* 卖超警示 icon 并入 hover 触发区(尺寸同 CEX 代币行的 NoteIndicator glyph:size-3;色用语义 --warn)。 */}
                {oversold ? (
                  <AlertTriangle
                    className="ml-1 inline size-3 align-middle text-warn"
                    aria-hidden
                  />
                ) : null}
              </HoverDetail>
            </div>
            <div className="mt-1.5 truncate text-xs">
              <span className={kindTone[a.kind]}>{t(a.kind)}</span>
              {a.memo ? <span className="text-muted-foreground"> · {a.memo}</span> : null}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {a.price != null ? (
              <div className="font-medium text-sm tabular-nums">
                {format.number(a.amount * a.price, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 2,
                })}
              </div>
            ) : null}
            <div className="text-muted-foreground text-xs tabular-nums">
              {dateFmt.format(a.occurredAt)}
            </div>
          </div>
        </div>
      ),
    };
  });

  return (
    <>
      <Tabs value={tab} onValueChange={setTab} variant="pill">
        <div className="flex items-center justify-between">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger value="tokens">{ta("tokensTab")}</TabsTrigger>
            <TabsTrigger value="activity">{t("title")}</TabsTrigger>
          </TabsList>
          <button
            type="button"
            onClick={openPlus}
            aria-label={t("addActivityTitle")}
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <TabsContent value="tokens">
          {detailQuery.isLoading ? (
            <DetailSkeleton />
          ) : tokenItems.length > 0 ? (
            <SwipeableList items={tokenItems} classNames={flatSwipe} />
          ) : (
            <EmptyState title={t("tokensEmpty")} hint={t("tokensEmptyHint")} />
          )}
        </TabsContent>

        <TabsContent value="activity">
          {detailQuery.isLoading ? (
            <DetailSkeleton />
          ) : activityItems.length > 0 ? (
            <SwipeableList items={activityItems} classNames={flatSwipe} />
          ) : (
            <EmptyState title={t("empty")} hint={t("emptyHint")} />
          )}
        </TabsContent>
      </Tabs>

      <ManualActivityModal
        open={activity.open}
        defaultToken={activity.token}
        lockToken={activity.lock}
        edit={activity.edit}
        owned={ownedOptions}
        onClose={closeActivity}
        onSubmit={(drafts) => addActivitiesMut.mutate(drafts)}
        onEdit={(_tokenId, activityId, patch) => editActivityMut.mutate({ activityId, patch })}
        pending={activityPending}
        submitResult={activitySubmitResult}
      />

      <ConfirmModal
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={t("confirmDeleteBody")}
        confirmLabel={tc("delete")}
        cancelLabel={tc("cancel")}
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex min-h-[68px] items-center gap-3 rounded-xl px-3 py-2.5">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-3.5 w-16 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  return (
    // Portal 到 body:同 ManualActivityModal —— 逃出 BottomSheet 的 transform/overflow 包含块。
    <Portal>
      <MorphingModal
        viewId={open ? "confirm" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="font-semibold text-base">{title}</h2>
              <p className="mt-1 text-muted-foreground text-sm">{body}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
                {cancelLabel}
              </Button>
              <Button type="button" variant="destructive" className="flex-1" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </div>
        )}
      </MorphingModal>
    </Portal>
  );
}

// 活动行 hover 明细:该笔活动的完整信息(类型/数量/单价/价值/手续费/日期/备注)。
// 缺省字段(未记单价/手续费/备注)不显示;类型/数量/日期恒有。
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

function ActivityDetail({
  row,
  totalThen,
  oversold,
  t,
  format,
  dateTimeFmt,
}: {
  row: ActivityRow;
  totalThen: number;
  oversold: boolean;
  t: (key: string) => string;
  format: ReturnType<typeof useFormatter>;
  dateTimeFmt: Intl.DateTimeFormat;
}) {
  const usd = (v: number) =>
    format.number(v, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  return (
    <div className="flex flex-col gap-2 text-sm">
      <DetailRow label={t("typeLabel")}>
        <span className={kindTone[row.kind]}>{t(row.kind)}</span>
      </DetailRow>
      <DetailRow label={t("amountLabel")}>
        {formatNumber(row.amount)} {row.symbol.toUpperCase()}
      </DetailRow>
      {row.price != null && <DetailRow label={t("priceLabel")}>{usd(row.price)}</DetailRow>}
      {row.price != null && (
        <DetailRow label={t("valuePreview")}>{usd(row.amount * row.price)}</DetailRow>
      )}
      {row.fee != null && <DetailRow label={t("feeLabel")}>{usd(row.fee)}</DetailRow>}
      <DetailRow label={t("dateLabel")}>{dateTimeFmt.format(row.occurredAt)}</DetailRow>

      {/* 此时账户总额(该活动发生时刻,账户全部 token 现算);卖超时如实提示,不改折叠结果。 */}
      <div className="flex flex-col gap-1.5 border-border border-t pt-2">
        <DetailRow label={t("accountTotalThen")}>{usd(totalThen)}</DetailRow>
        {oversold ? (
          <p className="text-muted-foreground text-xs leading-relaxed">{t("oversoldNotice")}</p>
        ) : null}
      </div>

      {row.memo ? (
        <div className="flex flex-col gap-0.5 border-border border-t pt-2">
          <span className="text-muted-foreground text-xs">{t("memoLabel")}</span>
          <p className="whitespace-pre-wrap break-words">{row.memo}</p>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <p className="font-medium text-sm">{title}</p>
      <p className="text-muted-foreground text-sm">{hint}</p>
    </div>
  );
}
