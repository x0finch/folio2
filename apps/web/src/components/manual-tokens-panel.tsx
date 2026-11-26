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
import { AlertTriangle, Pencil, Plus, Trash2 } from "@folio/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { OverviewBalance } from "@/lib/core/account-view";
import { formatNumber } from "@/lib/core/format-number";
import {
  accountTotalAt,
  type HistoryActivity,
  type HistoryToken,
  isReduceOversold,
} from "@/lib/core/manual";
import type { TokenOption } from "@/lib/core/token-model";
import { useLocalDateFormat } from "@/lib/hooks/use-local-date-format";
import { manualAccountQuery } from "@/lib/queries/accounts";
import { invalidateFor } from "@/lib/queries/refresh";
import {
  createManualActivities,
  removeManualActivity,
  updateManualActivity,
} from "@/lib/server/manual-activities";
import { removeManualToken } from "@/lib/server/manual-tokens";
import { TokenRowContent } from "@/routes/_authed/-home/holdings/tokens/token-row";
import { HoverDetail } from "./hover-detail";
import type { ActivityDraft, PickedToken } from "./manual-activity-modal";
import {
  type ActivityPatch,
  type EditActivityInput,
  ManualActivityModal,
  type SubmitResult,
} from "./manual-activity-modal";
import { Portal } from "./portal";
import { Sensitive } from "./sensitive";
import { buildOwnedOptions } from "./token-search";

// Data is read live from getManualAccountDetail; writes invalidate that query.

const kindTone: Record<string, string> = {
  add: "text-pos",
  reduce: "text-neg",
  set: "text-muted-foreground",
};

// Opaque bg-background hides the action rail before the swipe; min-h matches the home token row.
const flatSwipe: SwipeableListClassNames = {
  item: "rounded-xl bg-background",
  surface:
    "flex min-h-[68px] items-center rounded-xl border-0 bg-background px-3 py-3 shadow-none transition-colors hover:bg-muted",
  action: "[&>span]:group-hover:bg-muted!",
};

interface ActivityRow extends ManualActivity {
  symbol: string;
  logo?: string;
}

const LIST_DATE_FMT = { dateStyle: "medium" } as const;
const DETAIL_DATETIME_FMT = { dateStyle: "medium", timeStyle: "medium" } as const;

export function ManualTokensPanel({
  accountId,
  balances,
  gainPending = false,
}: {
  accountId: string;
  balances: OverviewBalance[];
  /** Shows a skeleton in the 24h change slot while it loads. */
  gainPending?: boolean;
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

  // Balances supply logo/name/live value; matched to ledger tokens by uppercase symbol.
  const balBySymbol = useMemo(
    () => new Map(balances.map((b) => [(b.symbol ?? "").toUpperCase(), b])),
    [balances],
  );
  const tokenById = useMemo(() => new Map(tokens.map((tk) => [tk.id, tk])), [tokens]);

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
      unitPrice: tk.unitPrice ?? 0, // 0 = never declared
    };
  };

  const merged = useMemo<ActivityRow[]>(() => {
    return [...activities]
      .sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt)
      .map((a) => {
        const tk = a.tokenId ? tokenById.get(a.tokenId) : undefined;
        const symbol = tk?.symbol ?? "?";
        return { ...a, symbol, logo: balBySymbol.get(symbol.toUpperCase())?.logo };
      });
  }, [activities, tokenById, balBySymbol]);

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

  // An oversell returns `{ ok: false }` rather than throwing, so only `ok` refreshes and closes;
  // otherwise the modal stays open. Errors show inside the modal, since a toast would sit
  // underneath it.
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
      if (!res.ok) return;
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

  const latest = merged[0];
  const latestTokenRow = latest?.tokenId ? tokenById.get(latest.tokenId) : undefined;
  const latestToken = latestTokenRow ? pickedTokenOf(latestTokenRow) : null;

  // Mutation state outlives the modal; reset it so a previous "oversold" error doesn't reappear.
  const openActivity = (next: Omit<typeof activity, "open">) => {
    addActivitiesMut.reset();
    editActivityMut.reset();
    setActivity({ ...next, open: true });
  };

  const openPlus = () => openActivity({ token: latestToken, lock: false, edit: null });
  const openTokenEdit = (tk: (typeof tokens)[number]) =>
    openActivity({ token: pickedTokenOf(tk), lock: true, edit: null });
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
    const value = bal ? bal.usdValue : tk.amount * (tk.unitPrice ?? 0);
    const rightActions: SwipeAction[] = [
      {
        id: "edit",
        label: t("addActivityTitle"),
        icon: <Pencil />,
        tone: "neutral",
        onClick: () => openTokenEdit(tk),
      },
      {
        id: "delete",
        label: tc("delete"),
        icon: <Trash2 />,
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
            // Required: without it TokenRowContent silently omits the 24h change.
            gain24h: bal?.gain24h,
          }}
          gainPending={gainPending}
        />
      ),
      rightActions,
    };
  });

  const activityItems: SwipeableListItem[] = merged.map((a) => {
    const oversold = a.tokenId ? isReduceOversold(actsByToken.get(a.tokenId) ?? [], a) : false;
    return {
      id: a.id,
      rightActions: [
        {
          id: "edit",
          label: t("editActivityTitle"),
          icon: <Pencil />,
          tone: "neutral",
          onClick: () => openActivityEdit(a),
        },
        {
          id: "delete",
          label: tc("delete"),
          icon: <Trash2 />,
          tone: "neutral",
          onClick: () =>
            setConfirm({
              title: t("confirmDeleteActivity"),
              onConfirm: () => removeActivityMut.mutate(a.id),
            }),
        },
      ],
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
                <Sensitive>{formatNumber(a.amount)}</Sensitive> {a.symbol.toUpperCase()}
                {oversold ? (
                  <AlertTriangle className="ml-1 inline align-middle text-warn" aria-hidden />
                ) : null}
              </HoverDetail>
            </div>
            <div className="mt-2 truncate text-xs">
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
            <Plus />
          </button>
        </div>

        <TabsContent value="tokens">
          {detailQuery.isLoading ? (
            <DetailSkeleton />
          ) : tokenItems.length > 0 ? (
            <SwipeableList items={tokenItems} classNames={flatSwipe} />
          ) : (
            <EmptyState title={t("tokensEmpty")} />
          )}
        </TabsContent>

        <TabsContent value="activity">
          {detailQuery.isLoading ? (
            <DetailSkeleton />
          ) : activityItems.length > 0 ? (
            <SwipeableList items={activityItems} classNames={flatSwipe} />
          ) : (
            <EmptyState title={t("empty")} />
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
        <div key={i} className="flex min-h-[68px] items-center gap-3 rounded-xl px-3 py-3">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-24 animate-pulse rounded-md bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded-md bg-muted" />
          </div>
          <div className="h-4 w-16 animate-pulse rounded-md bg-muted" />
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
    // Portal to body to escape the BottomSheet's transform/overflow containing block.
    <Portal>
      <MorphingModal
        viewId={open ? "confirm" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="font-semibold text-lg">{title}</h2>
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
        {/* Unit price is market data, so it isn't masked; amount, value and fee are. */}
        <Sensitive>{formatNumber(row.amount)}</Sensitive> {row.symbol.toUpperCase()}
      </DetailRow>
      {row.price != null && <DetailRow label={t("priceLabel")}>{usd(row.price)}</DetailRow>}
      {row.price != null && (
        <DetailRow label={t("valuePreview")}>
          <Sensitive>{usd(row.amount * row.price)}</Sensitive>
        </DetailRow>
      )}
      {row.fee != null && (
        <DetailRow label={t("feeLabel")}>
          <Sensitive>{usd(row.fee)}</Sensitive>
        </DetailRow>
      )}
      <DetailRow label={t("dateLabel")}>{dateTimeFmt.format(row.occurredAt)}</DetailRow>

      <div className="flex flex-col gap-2 border-border border-t pt-2">
        <DetailRow label={t("accountTotalThen")}>
          <Sensitive>{usd(totalThen)}</Sensitive>
        </DetailRow>
        {oversold ? (
          <p className="text-muted-foreground text-xs leading-relaxed">{t("oversoldNotice")}</p>
        ) : null}
      </div>

      {row.memo ? (
        <div className="flex flex-col gap-1 border-border border-t pt-2">
          <span className="text-muted-foreground text-xs">{t("memoLabel")}</span>
          <p className="whitespace-pre-wrap break-words">{row.memo}</p>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return <p className="px-6 py-12 text-center text-muted-foreground text-sm">{title}</p>;
}
