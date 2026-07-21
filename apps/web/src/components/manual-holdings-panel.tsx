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
  useMediaQuery,
} from "@folio/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { OverviewBalance } from "../lib/account-view";
import { formatNumber } from "../lib/format-number";
import { useManualStore } from "../lib/hooks/use-manual-store";
import { type DraftTokenRef, type Holding, holdingAmount } from "../lib/manual-store";
import { type EditActivityInput, ManualActivityModal } from "./manual-activity-modal";
import { Portal } from "./portal";
import { TokenRowContent } from "./token-row";

// manual 账户详情抽屉的多 token 面板(A5 F 片,内存态原型)。Tokens|Activity 双 tab(全圆 pill,默认 Tokens)+
// tab 行右 ghost plus(一律开 Add activity)。两个 SwipeableList 去卡片(surface = 抽屉底色平铺 + hover:bg-muted,
// 与主页 SharedLayoutBg 药丸同色);Tokens 复用主页 <TokenRowContent>。token 行 swipe:编辑=开 Add activity 并锁定该
// token、删除=确认 modal;activity 行 swipe:删除=确认 modal。数据暂存内存(useManualStore);持久化见 D 片。

const kindTone: Record<string, string> = {
  add: "text-pos",
  reduce: "text-neg",
  set: "text-muted-foreground",
};

// swipe 行去卡片:surface 用抽屉底色 bg-background(不透明遮住滑出前的操作轨);flex items-center 垂直居中;
// min-h-[68px](= 主页代币行高)让 Tokens 与 Activity 两列表行高一致;hover:bg-muted 给悬停反馈。
// 第二层(滑出的操作轨)背景也用 bg-background(item),与 surface 同底 → 操作图标(neutral = muted-foreground)平铺其上。
// action:vendored 图标 hover 圈是 group-hover:bg-background,与轨同底(不可见)→ 覆写成 bg-muted(轨上有对比,`!` 压过内建)。
const flatSwipe: SwipeableListClassNames = {
  item: "rounded-xl bg-background",
  surface:
    "flex min-h-[68px] items-center rounded-xl border-0 bg-background px-3 py-2.5 shadow-none transition-colors hover:bg-muted",
  action: "[&>span]:group-hover:bg-muted!",
};

function tokenRef(h: Holding): DraftTokenRef {
  return {
    symbol: h.symbol,
    identifier: h.identifier,
    logo: h.logo,
    name: h.name,
    unitPrice: h.unitPrice,
  };
}

export function ManualHoldingsPanel({ balances }: { balances: OverviewBalance[] }) {
  const t = useTranslations("Activity");
  const ta = useTranslations("Accounts");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const store = useManualStore(balances);

  const [tab, setTab] = useState("tokens");
  // Add/Edit activity modal:token 可预选(plus,最新活动的 token)、锁定(token 行编辑)、或编辑既有活动(edit 预填)。
  const [activity, setActivity] = useState<{
    open: boolean;
    token: DraftTokenRef | null;
    lock: boolean;
    edit: EditActivityInput | null;
  }>({ open: false, token: null, lock: false, edit: null });
  // 删除二次确认 modal。
  const [confirm, setConfirm] = useState<{ title: string; onConfirm: () => void } | null>(null);

  // 默认选中最新一笔活动的 token(供 plus 预选)。
  const latest = store.merged[0];
  const latestHolding = latest && store.holdings.find((h) => h.id === latest.holdingId);
  const latestToken = latestHolding ? tokenRef(latestHolding) : null;

  const openPlus = () => setActivity({ open: true, token: latestToken, lock: false, edit: null });
  const openTokenEdit = (h: Holding) =>
    setActivity({ open: true, token: tokenRef(h), lock: true, edit: null });
  // 活动行「编辑」:锁定该 token,预填这笔活动的全部字段(kind/数量/单价/手续费/日期/备注)。
  const openActivityEdit = (a: (typeof store.merged)[number]) => {
    const h = store.holdings.find((x) => x.id === a.holdingId);
    const token = h ? tokenRef(h) : { symbol: a.symbol, logo: a.logo, unitPrice: 0 };
    setActivity({
      open: true,
      token,
      lock: true,
      edit: {
        holdingId: a.holdingId,
        activityId: a.id,
        token,
        kind: a.kind,
        amount: a.amount,
        price: a.price,
        fee: a.fee,
        occurredAt: a.occurredAt,
        memo: a.memo,
      },
    });
  };
  const closeActivity = () => setActivity((s) => ({ ...s, open: false }));

  // 列表项直接由内存态派生(小列表,无需 memo);action 回调闭包捕获当前 store。
  const tokenItems: SwipeableListItem[] = store.holdings.map((h) => {
    const amount = holdingAmount(h);
    const rightActions: SwipeAction[] = [
      {
        id: "edit",
        label: t("addActivityTitle"),
        icon: <Pencil className="size-4" />,
        tone: "neutral",
        onClick: () => openTokenEdit(h),
      },
      {
        id: "delete",
        label: tc("delete"),
        icon: <Trash2 className="size-4" />,
        tone: "neutral",
        onClick: () =>
          setConfirm({
            title: t("confirmDeleteToken", { symbol: h.symbol.toUpperCase() }),
            onConfirm: () => store.remove(h.id),
          }),
      },
    ];
    return {
      id: h.id,
      // 主页 Tokens 视图同一行式布局:logo + 名称 / 数量·symbol + 右侧市值。
      content: (
        <TokenRowContent
          item={{
            logo: h.logo,
            name: h.name ?? h.symbol.toUpperCase(),
            symbol: h.symbol.toUpperCase(),
            amount,
            value: amount * h.unitPrice,
          }}
        />
      ),
      rightActions,
    };
  });

  const activityItems: SwipeableListItem[] = store.merged.map((a) => ({
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
            onConfirm: () => store.removeActivity(a.holdingId, a.id),
          }),
      },
    ],
    // 字体与 <TokenRowContent> 同位对齐:第一行 = 名称位(font-medium 基号)、第二行 = 数量·symbol 位(text-xs)。
    content: (
      <div className="flex w-full items-center gap-3">
        <LogoAvatar src={a.logo} fallback={a.symbol} size="md" />
        <div className="min-w-0 flex-1">
          <div className="min-w-0 truncate font-medium tabular-nums">
            {formatNumber(a.amount)} {a.symbol.toUpperCase()}
          </div>
          <div className="truncate text-xs">
            <span className={kindTone[a.kind]}>{t(a.kind)}</span>
            {a.memo ? <span className="text-muted-foreground"> · {a.memo}</span> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* 价值 = 数量 × 该笔单价(有单价才显),呼应主页代币行右侧市值;日期次要弱化其下 */}
          {a.price ? (
            <div className="font-medium text-sm tabular-nums">
              {format.number(a.amount * a.price, {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 2,
              })}
            </div>
          ) : null}
          <div className="text-muted-foreground text-xs tabular-nums">
            {format.dateTime(new Date(a.occurredAt), { dateStyle: "medium" })}
          </div>
        </div>
      </div>
    ),
  }));

  return (
    <>
      <Tabs value={tab} onValueChange={setTab} variant="pill">
        <div className="flex items-center justify-between">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger value="tokens">{ta("holdingsTab")}</TabsTrigger>
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
          {tokenItems.length > 0 ? (
            <SwipeableList items={tokenItems} classNames={flatSwipe} />
          ) : (
            <EmptyState title={t("tokensEmpty")} hint={t("tokensEmptyHint")} />
          )}
        </TabsContent>

        <TabsContent value="activity">
          {activityItems.length > 0 ? (
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
        onClose={closeActivity}
        onSubmit={(drafts) => {
          const res = store.commit(drafts);
          if (res.ok) {
            setActivity((s) => ({ ...s, open: false }));
            setTab("activity");
          }
          return { ok: res.ok };
        }}
        onEdit={(holdingId, activityId, patch) => {
          const res = store.editActivity(holdingId, activityId, patch);
          if (res.ok) setActivity((s) => ({ ...s, open: false }));
          return { ok: res.ok };
        }}
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

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <p className="font-medium text-sm">{title}</p>
      <p className="text-muted-foreground text-sm">{hint}</p>
    </div>
  );
}
