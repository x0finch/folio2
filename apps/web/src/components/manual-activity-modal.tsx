import type { TokenInfo } from "@folio/tokens";
import {
  Button,
  cn,
  Input,
  Label,
  LogoAvatar,
  MorphingModal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useMediaQuery,
} from "@folio/ui";
import { CalendarDays, ChevronDown, Pencil, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { formatNumber } from "../lib/format-number";
import { useHoverPopover } from "../lib/hooks/use-hover-popover";
import { useTokenPrice } from "../lib/hooks/use-token-price";
import type { ActivityDraft, DraftTokenRef } from "../lib/manual-store";
import { DateWheel } from "./date-wheel";
import { Portal } from "./portal";
import { TokenCombobox } from "./token-combobox";

// manual 活动的暂存批量录入（grill Q3–Q8 + 迭代）：token 用 CGK 全量列表（记活动即可建 token）、type 用 Tabs、
// 日期默认今天先显文字点开才展开滚轮。「再添加一笔」压入待提交列表、「提交」= 列表 + 当前草稿。
// **backdrop 不关**（onClose 传 no-op），仅 ✕ 关；有未保存内容时 ✕ 就地出「不保存关闭 / 继续」两按钮（不再另弹确认）。

// beUI EASE_OUT 动效曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Kind = ActivityDraft["kind"];

interface DraftForm {
  token: DraftTokenRef | null;
  kind: Kind;
  amount: string;
  occurredAt: number;
  memo: string;
}

const KINDS: Kind[] = ["add", "reduce", "set"];

function midnightToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// DraftTokenRef → TokenCombobox 可显示的 TokenInfo（仅展示,不校验 ref.source）。无 identifier → null（走手动模式）。
function toTokenInfo(token: DraftTokenRef | null): TokenInfo | null {
  if (!token?.identifier) return null;
  return {
    ref: { source: "coingecko", identifier: token.identifier as TokenInfo["ref"]["identifier"] },
    symbol: token.symbol,
    name: token.name ?? "",
    logo: token.logo,
  };
}

function draftValid(d: DraftForm): boolean {
  if (!d.token?.symbol.trim()) return false;
  const n = Number(d.amount);
  if (d.amount.trim() === "" || !Number.isFinite(n)) return false;
  return d.kind === "set" ? n >= 0 : n > 0;
}

function ActivityForm({
  defaultToken,
  lockToken = false,
  onClose,
  onSubmit,
}: {
  defaultToken: DraftTokenRef | null;
  lockToken?: boolean; // 从 token 行「编辑」进入:锁定该 token,不可改
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => { ok: boolean };
}) {
  const t = useTranslations("Activity");
  const tc = useTranslations("Common");
  const ta = useTranslations("Accounts");
  const format = useFormatter();
  const { fetchPrice } = useTokenPrice();
  const kindPop = useHoverPopover();

  const emptyDraft = (): DraftForm => ({
    token: defaultToken,
    // token 行「编辑」进入默认「校准」(set,直接改到目标余额);plus 新增默认「增加」(add)。均可后续再改。
    kind: lockToken ? "set" : "add",
    amount: "",
    occurredAt: midnightToday(),
    memo: "",
  });

  const [pending, setPending] = useState<DraftForm[]>([]);
  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [picked, setPicked] = useState<TokenInfo | null>(toTokenInfo(defaultToken));
  const [manualMode, setManualMode] = useState(Boolean(defaultToken && !defaultToken.identifier));
  const [showWheel, setShowWheel] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);

  // 滚轮展开时点组件外 → 收起回文字态(失焦自动关)。
  useEffect(() => {
    if (!showWheel) return;
    const onDown = (e: PointerEvent) => {
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) setShowWheel(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [showWheel]);

  const setD = <K extends keyof DraftForm>(key: K, v: DraftForm[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));

  const onPick = (tok: TokenInfo | null) => {
    setPicked(tok);
    if (!tok) {
      setD("token", null);
      return;
    }
    const id = tok.ref.identifier;
    setD("token", {
      symbol: tok.symbol.toUpperCase(),
      identifier: id,
      logo: tok.logo,
      name: tok.name,
      unitPrice: 0,
    });
    // 市价异步回填(竞态守卫);仍指向同一 token 才写入。
    fetchPrice(id, (p) =>
      setDraft((d) =>
        d.token?.identifier === id ? { ...d, token: { ...d.token, unitPrice: p } } : d,
      ),
    );
  };

  const dirty = pending.length > 0 || draftValid(draft);

  // 载入某个待提交项到草稿(原位编辑),同步选币显示态。
  const loadDraft = (d: DraftForm) => {
    setDraft(d);
    setPicked(toTokenInfo(d.token));
    setManualMode(Boolean(d.token && !d.token.identifier));
    setShowWheel(false);
  };

  const resetAfterStage = () => {
    // 保留 token/日期,清 amount/memo(便于连续录同一 token)。
    setDraft((d) => ({ ...d, amount: "", memo: "" }));
    document.getElementById("ma-amount")?.focus();
  };

  const stage = () => {
    if (!draftValid(draft)) return;
    setError(null);
    if (editingIndex != null) {
      setPending((p) => p.map((d, i) => (i === editingIndex ? draft : d)));
      setEditingIndex(null);
    } else {
      setPending((p) => [...p, draft]);
    }
    resetAfterStage();
  };

  const toDrafts = (): ActivityDraft[] => {
    const all = [...pending];
    if (draftValid(draft) && editingIndex == null) all.push(draft);
    const base = Date.now();
    return all
      .filter((d): d is DraftForm & { token: DraftTokenRef } => d.token != null)
      .map((d, i) => ({
        token: d.token,
        kind: d.kind,
        amount: Number(d.amount),
        occurredAt: d.occurredAt,
        createdAt: base + i,
        memo: d.memo.trim() || undefined,
      }));
  };

  const submit = () => {
    const drafts = toDrafts();
    if (drafts.length === 0) return;
    const res = onSubmit(drafts);
    if (!res.ok) setError(t("reduceTooMuch"));
  };

  const removePending = (i: number) => {
    setPending((p) => p.filter((_, idx) => idx !== i));
    if (editingIndex === i) {
      setEditingIndex(null);
      loadDraft(emptyDraft());
    }
  };

  const requestClose = () => {
    if (dirty) setClosing(true);
    else onClose();
  };

  const submitCount = pending.length + (draftValid(draft) && editingIndex == null ? 1 : 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-base">{t("addActivityTitle")}</h2>
        <button
          type="button"
          onClick={requestClose}
          aria-label={tc("close")}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* token:锁定时静态展示(从 token 行进入);否则 CGK 全量选币(记活动即可建 token) */}
      <div className="flex flex-col gap-2">
        <Label>{t("token")}</Label>
        {lockToken ? (
          <div className="flex h-11 items-center gap-2 rounded-full border border-border bg-muted px-3.5 text-sm">
            <LogoAvatar src={defaultToken?.logo} fallback={defaultToken?.symbol ?? "?"} size="sm" />
            <span className="font-medium">{defaultToken?.symbol}</span>
            {defaultToken?.name ? (
              <span className="truncate text-muted-foreground">{defaultToken.name}</span>
            ) : null}
          </div>
        ) : manualMode ? (
          <>
            <Input
              autoComplete="off"
              value={draft.token?.symbol ?? ""}
              onChange={(v) =>
                setD("token", { symbol: v.toUpperCase(), unitPrice: draft.token?.unitPrice ?? 0 })
              }
              placeholder="BTC"
            />
            <button
              type="button"
              className="self-start text-muted-foreground text-xs underline"
              onClick={() => {
                setManualMode(false);
                setD("token", null);
                setPicked(null);
              }}
            >
              {ta("searchInstead")}
            </button>
          </>
        ) : (
          <TokenCombobox
            value={picked}
            onChange={onPick}
            onManual={(q) => {
              setManualMode(true);
              setPicked(null);
              setD("token", { symbol: q.toUpperCase(), unitPrice: 0 });
            }}
          />
        )}
      </div>

      {/* type + amount 合并一行:type 作 Select,amount 填满其余 */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="ma-amount">{t("amountLabel")}</Label>
        <div className="flex items-stretch gap-2">
          {/* type:hover popover(非 select 组件)——悬停触发器展开三选项,选中即写入。中性色(不着红绿)、
              左对齐、窄触发器(w-28),把余下宽度让给 amount input。 */}
          <Popover
            trigger="hover"
            side={kindPop.side}
            align="start"
            panelRadius={16}
            onOpenChange={kindPop.onOpenChange}
            className={cn("w-28 shrink-0", kindPop.rootClassName)}
          >
            <PopoverTrigger>
              <button
                ref={kindPop.measureRef}
                type="button"
                className="flex h-11 w-full items-center justify-between gap-1.5 rounded-full border border-border px-3.5 font-medium text-foreground text-sm outline-none transition-colors hover:border-foreground/40"
              >
                {t(draft.kind)}
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex w-28 flex-col gap-0.5">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setD("kind", k)}
                    className={cn(
                      "flex w-full items-center rounded-lg px-3 py-2 text-left font-medium text-sm transition-colors hover:bg-muted",
                      draft.kind === k && "bg-muted",
                    )}
                  >
                    {t(k)}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Input
            id="ma-amount"
            className="flex-1"
            inputMode="decimal"
            value={draft.amount}
            onChange={(v) => setD("amount", v)}
            placeholder={t("amountPlaceholder")}
          />
        </div>
      </div>

      {/* date:默认今天,先显文字;点击展开滚轮(带高度动画),点组件外收起 */}
      <div ref={dateRef} className="flex flex-col gap-2">
        <Label>{t("dateLabel")}</Label>
        <button
          type="button"
          onClick={() => setShowWheel((s) => !s)}
          className={cn(
            "flex h-11 items-center gap-2 rounded-full border px-3.5 text-sm outline-none transition-colors",
            showWheel ? "border-foreground/40" : "border-border hover:border-foreground/40",
          )}
        >
          <CalendarDays className="size-4 text-muted-foreground" />
          {format.dateTime(new Date(draft.occurredAt), { dateStyle: "medium" })}
        </button>
        <AnimatePresence initial={false}>
          {showWheel && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <DateWheel value={draft.occurredAt} onChange={(ms) => setD("occurredAt", ms)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ma-memo">{t("memoLabel")}</Label>
        <Input
          id="ma-memo"
          value={draft.memo}
          onChange={(v) => setD("memo", v)}
          placeholder={t("memoPlaceholder")}
        />
      </div>

      {/* 待提交列表 */}
      {pending.length > 0 && (
        <div className="flex flex-col gap-1.5 border-border border-t pt-3">
          <p className="text-muted-foreground text-xs">{t("pending", { count: pending.length })}</p>
          {pending.map((d, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: staged rows are positional, reorder-free
              key={i}
              className={cn(
                "flex items-center gap-2.5 rounded-lg bg-card px-3 py-2",
                editingIndex === i && "ring-1 ring-primary",
              )}
            >
              <LogoAvatar src={d.token?.logo} fallback={d.token?.symbol ?? "?"} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">
                  {formatNumber(Number(d.amount))} {d.token?.symbol}
                </div>
                <div className="truncate text-muted-foreground text-xs">
                  {t(d.kind)} · {format.dateTime(new Date(d.occurredAt), { dateStyle: "medium" })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingIndex(i);
                  loadDraft(d);
                }}
                aria-label={tc("edit")}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => removePending(i)}
                aria-label={t("remove")}
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* 底部动作:关闭态 → 两按钮;编辑态 → 取消/保存;否则 → 再添加一笔/提交 */}
      <div className="mt-1 flex gap-2">
        {closing ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => setClosing(false)}
            >
              {t("continueEditing")}
            </Button>
            <Button type="button" variant="destructive" className="flex-1" onClick={onClose}>
              {t("closeWithoutSaving")}
            </Button>
          </>
        ) : editingIndex != null ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => {
                setEditingIndex(null);
                loadDraft(emptyDraft());
              }}
            >
              {tc("cancel")}
            </Button>
            <Button type="button" className="flex-1" onClick={stage} disabled={!draftValid(draft)}>
              {tc("save")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={stage}
              disabled={!draftValid(draft)}
            >
              <Plus className="size-4" />
              {t("addAnother")}
            </Button>
            <Button type="button" className="flex-1" onClick={submit} disabled={submitCount === 0}>
              {t("submit")}
              {submitCount > 0 ? ` (${submitCount})` : ""}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function ManualActivityModal({
  open,
  defaultToken,
  lockToken = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  defaultToken: DraftTokenRef | null; // 默认选中(最新一笔活动的 token,或 token 行进入时锁定的 token)
  lockToken?: boolean; // token 行「编辑」进入:锁定 token 不可改
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => { ok: boolean };
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  return (
    // Portal 到 body:承载抽屉在移动端是 BottomSheet(transform 包含块 + overflow-hidden),
    // 直接渲染会把 fixed 的 MorphingModal 裁在 sheet 内 —— 逃到 body 才相对视口定位。
    <Portal>
      {/* onClose 传 no-op:backdrop 点击不关(grill Q3)。真正的关闭走表单内的 ✕(有未保存内容则就地确认)。 */}
      <MorphingModal
        viewId={open ? "activity" : null}
        onClose={() => {}}
        placement={isDesktop ? "center" : "bottom"}
      >
        {open && (
          // key:切换锁定/预选 token 时重挂,草稿态按新 defaultToken 重置。
          <ActivityForm
            key={`${lockToken ? "lock" : "free"}:${defaultToken?.identifier ?? defaultToken?.symbol ?? "none"}`}
            defaultToken={defaultToken}
            lockToken={lockToken}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        )}
      </MorphingModal>
    </Portal>
  );
}
