import {
  Button,
  cn,
  Input,
  Label,
  LogoAvatar,
  MorphingModal,
  NumberTicker,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  useMediaQuery,
} from "@folio/ui";
import { Receipt, StickyNote, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import type { TokenOption } from "@/lib/core/token-model";
import { useLocalDateFormat } from "@/lib/hooks/use-local-date-format";
import { useTokenPrice } from "@/lib/hooks/use-token-price";
import { DateTimeWheel } from "./date-time-wheel";
import { IconButton } from "./icon-button";
import { Portal } from "./portal";
import { TokenCombobox } from "./token-combobox";

// An activity may target a token not yet held; it is created on submit.
// `ticket` is passed through opaquely; without it the user typed a symbol by hand.
export interface PickedToken {
  symbol: string;
  ticket?: string;
  logo?: string;
  name?: string;
  unitPrice: number;
}

// `createdAt` only orders drafts client-side; the server assigns the stored order.
export interface ActivityDraft {
  token: PickedToken;
  kind: "add" | "reduce" | "set";
  amount: number;
  occurredAt: number;
  createdAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

// Single-activity entry. The backdrop doesn't close it (only ✕, which asks to confirm when dirty).
// The price defaults to the market price until the user edits it.

// Mirrors beUI's EASE_OUT token (@folio/ui doesn't export lib/ease).
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Kind = ActivityDraft["kind"];

export interface EditActivityInput {
  tokenId: string;
  activityId: string;
  token: PickedToken;
  kind: Kind;
  amount: number;
  price?: number;
  fee?: number;
  occurredAt: number;
  memo?: string;
}

// `over` is a normal business rejection (oversell; fix the number), `failed` means the write
// didn't happen. Keep them apart so the first stays actionable.
export type SubmitResult = "over" | "failed" | null;

export interface ActivityPatch {
  kind: Kind;
  amount: number;
  occurredAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

interface DraftForm {
  token: PickedToken | null;
  kind: Kind;
  amount: string;
  price: string;
  fee: string;
  occurredAt: number;
  memo: string;
}

const KINDS: Kind[] = ["add", "reduce", "set"];

// No beUI Textarea, so a token-only local one mirroring Input; field-sizing grows with content.
const NOTES_CLASS =
  "w-full resize-none rounded-2xl border border-border bg-transparent px-3.5 py-2.5 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 [field-sizing:content] min-h-24 max-h-32";

const GHOST_ICON =
  "flex size-7 items-center justify-center rounded-full outline-none transition-colors hover:bg-background/60";

// The card shows a 2-digit year; the wheel uses the full year.
const DATE_FMT = { year: "2-digit", month: "short", day: "numeric" } as const;
const TIME_FMT = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } as const;

// Unmounts on exit, so as a flex sibling it leaves no ghost gap.
function Expandable({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="expandable"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// No ticket = the user typed a symbol, so show manual mode (null).
function toOption(token: PickedToken | null): TokenOption | null {
  if (!token?.ticket) return null;
  return {
    ticket: token.ticket,
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

function numOrUndef(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function sameDraft(a: DraftForm, b: DraftForm): boolean {
  const tokA = a.token?.ticket ?? a.token?.symbol ?? null;
  const tokB = b.token?.ticket ?? b.token?.symbol ?? null;
  return (
    tokA === tokB &&
    a.kind === b.kind &&
    a.amount === b.amount &&
    a.price === b.price &&
    a.fee === b.fee &&
    a.occurredAt === b.occurredAt &&
    a.memo === b.memo
  );
}

function ActivityForm({
  defaultToken,
  lockToken = false,
  edit,
  owned,
  onClose,
  onSubmit,
  onEdit,
  pending,
  submitResult,
}: {
  defaultToken: PickedToken | null;
  lockToken?: boolean;
  edit?: EditActivityInput | null;
  owned?: readonly TokenOption[];
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => void;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => void;
  pending: boolean;
  submitResult: SubmitResult;
}) {
  const t = useTranslations("Activity");
  const tc = useTranslations("Common");
  const ta = useTranslations("Accounts");
  const format = useFormatter();
  const { fetchPrice } = useTokenPrice();

  const dateFmt = useLocalDateFormat(DATE_FMT);
  const timeFmt = useLocalDateFormat(TIME_FMT);

  const editing = Boolean(edit);
  const lockedToken = edit?.token ?? defaultToken;
  const locked = editing || lockToken;

  // Default to now, floored to the second. Pinned in a ref because emptyDraft runs more than
  // once (initial snapshot + draft), and differing values would make the form look dirty.
  const openedAtRef = useRef(Math.floor(Date.now() / 1000) * 1000);

  const emptyDraft = (): DraftForm =>
    edit
      ? {
          token: edit.token,
          kind: edit.kind,
          amount: String(edit.amount),
          price: edit.price != null ? String(edit.price) : "",
          fee: edit.fee != null ? String(edit.fee) : "",
          occurredAt: edit.occurredAt,
          memo: edit.memo ?? "",
        }
      : {
          token: defaultToken,
          kind: lockToken ? "set" : "add",
          amount: "",
          price: defaultToken && defaultToken.unitPrice > 0 ? String(defaultToken.unitPrice) : "",
          fee: "",
          occurredAt: openedAtRef.current,
          memo: "",
        };

  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [picked, setPicked] = useState<TokenOption | null>(toOption(lockedToken));
  const [manualMode, setManualMode] = useState(Boolean(lockedToken && !lockedToken.ticket));
  const [openEditor, setOpenEditor] = useState<"date" | "time" | "fee" | "memo" | null>(null);
  const [closing, setClosing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  // Once the user edits the price, the async market price must not overwrite it.
  const priceTouched = useRef(Boolean(edit));
  const initialRef = useRef<DraftForm | null>(null);
  let initialDraft = initialRef.current;
  if (initialDraft === null) {
    initialDraft = emptyDraft();
    initialRef.current = initialDraft;
  }

  useEffect(() => {
    if (!openEditor) return;
    const onDown = (e: PointerEvent) => {
      if (previewRef.current && !previewRef.current.contains(e.target as Node)) setOpenEditor(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openEditor]);

  const setD = <K extends keyof DraftForm>(key: K, v: DraftForm[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));

  const onPick = (tok: TokenOption | null) => {
    setPicked(tok);
    if (!tok) {
      setD("token", null);
      return;
    }
    const { ticket } = tok;
    priceTouched.current = false;
    setDraft((d) => ({
      ...d,
      token: {
        symbol: tok.symbol.toUpperCase(),
        ticket,
        logo: tok.logo,
        name: tok.name,
        unitPrice: 0,
      },
      price: "",
    }));
    // Race guard: only apply if the same token is still selected.
    fetchPrice(ticket, (p) =>
      setDraft((d) => {
        if (d.token?.ticket !== ticket) return d;
        return {
          ...d,
          token: { ...d.token, unitPrice: p },
          price: priceTouched.current ? d.price : String(p),
        };
      }),
    );
  };

  const dirty = !sameDraft(draft, initialDraft);

  const toDrafts = (): ActivityDraft[] => {
    if (!draftValid(draft) || !draft.token) return [];
    return [
      {
        token: draft.token,
        kind: draft.kind,
        amount: Number(draft.amount),
        occurredAt: draft.occurredAt,
        createdAt: draft.occurredAt,
        memo: draft.memo.trim() || undefined,
        price: numOrUndef(draft.price),
        fee: draft.kind === "set" ? undefined : numOrUndef(draft.fee),
      },
    ];
  };

  // Fire-and-report: the parent mutation owns pending/result, so a thrown write surfaces as
  // `submitResult === "failed"` instead of an unhandled rejection.
  const submit = () => {
    const drafts = toDrafts();
    if (drafts.length === 0 || pending) return;
    onSubmit(drafts);
  };

  const saveEdit = () => {
    if (!edit || !onEdit || !draftValid(draft) || pending) return;
    onEdit(edit.tokenId, edit.activityId, {
      kind: draft.kind,
      amount: Number(draft.amount),
      occurredAt: draft.occurredAt,
      memo: draft.memo.trim() || undefined,
      price: numOrUndef(draft.price),
      fee: draft.kind === "set" ? undefined : numOrUndef(draft.fee),
    });
  };

  const error =
    submitResult === "over"
      ? t("reduceTooMuch")
      : submitResult === "failed"
        ? ta("actionFailed")
        : null;

  const requestClose = () => {
    if (dirty) setClosing(true);
    else onClose();
  };

  // No price shows "—", not $0, so "not entered" isn't read as "worth zero".
  const qty = Number(draft.amount);
  const priceNum = Number(draft.price);
  const hasPrice = numOrUndef(draft.price) != null;
  const value = Number.isFinite(qty * priceNum) ? qty * priceNum : 0;

  const feeSet = numOrUndef(draft.fee) != null;
  const memoSet = draft.memo.trim() !== "";
  const toggleEditor = (k: "date" | "time" | "fee" | "memo") =>
    setOpenEditor((cur) => (cur === k ? null : k));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-base">
          {editing ? t("editActivityTitle") : t("addActivityTitle")}
        </h2>
        <IconButton onClick={requestClose} aria-label={tc("close")}>
          <X className="size-4" />
        </IconButton>
      </div>

      <Tabs
        value={draft.kind}
        onValueChange={(v) => {
          setD("kind", v as Kind);
          if (v === "set" && openEditor === "fee") setOpenEditor(null);
        }}
        variant="segment"
        className="w-full"
      >
        {/* beUI doesn't expose the trigger wrapper's className, so size it via [&>div]. */}
        <TabsList className="w-full [&>div]:flex-1">
          {KINDS.map((k) => (
            <TabsTrigger
              key={k}
              value={k}
              // The default active text is unreadable on the dark muted pill; override it.
              className="w-full aria-selected:text-foreground"
              indicatorClassName="bg-muted"
            >
              {t(k)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {locked ? (
        <div className="flex h-11 items-center gap-2 rounded-full border border-border bg-muted px-3.5 text-sm">
          <LogoAvatar src={lockedToken?.logo} fallback={lockedToken?.symbol ?? "?"} size="sm" />
          <span className="font-medium">{lockedToken?.symbol}</span>
          {lockedToken?.name ? (
            <span className="truncate text-muted-foreground">{lockedToken.name}</span>
          ) : null}
        </div>
      ) : manualMode ? (
        <div className="flex flex-col gap-2">
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
        </div>
      ) : (
        <TokenCombobox
          value={picked}
          owned={owned}
          onChange={onPick}
          onManual={(q) => {
            setManualMode(true);
            setPicked(null);
            setD("token", { symbol: q.toUpperCase(), unitPrice: 0 });
          }}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ma-amount" className="px-1">
            {t("amountLabel")}
          </Label>
          <Input
            id="ma-amount"
            inputMode="decimal"
            value={draft.amount}
            onChange={(v) => setD("amount", v)}
            placeholder={t("amountPlaceholder")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ma-price" className="px-1">
            {t("priceLabel")}
          </Label>
          <Input
            id="ma-price"
            inputMode="decimal"
            leftIcon={<span>$</span>}
            value={draft.price}
            onChange={(v) => {
              priceTouched.current = true;
              setD("price", v);
            }}
            placeholder={t("pricePlaceholder")}
          />
        </div>
      </div>

      <div ref={previewRef} className="flex flex-col">
        <div className="relative rounded-2xl bg-muted px-4 py-3">
          <div className="absolute top-2 right-2 flex gap-0.5">
            {draft.kind !== "set" && (
              <Tooltip content={t("feeLabel")} side="top">
                <button
                  type="button"
                  onClick={() => toggleEditor("fee")}
                  aria-label={t("feeLabel")}
                  className={cn(
                    GHOST_ICON,
                    openEditor === "fee"
                      ? "bg-background text-primary"
                      : feeSet
                        ? "text-primary"
                        : "text-muted-foreground",
                  )}
                >
                  <Receipt className="size-3.5" />
                </button>
              </Tooltip>
            )}
            <Tooltip content={t("memoLabel")} side="top">
              <button
                type="button"
                onClick={() => toggleEditor("memo")}
                aria-label={t("memoLabel")}
                className={cn(
                  GHOST_ICON,
                  openEditor === "memo"
                    ? "bg-background text-primary"
                    : memoSet
                      ? "text-primary"
                      : "text-muted-foreground",
                )}
              >
                <StickyNote className="size-3.5" />
              </button>
            </Tooltip>
          </div>

          <p className="text-muted-foreground text-sm">{t("valuePreview")}</p>
          <div className="font-bold text-2xl">
            {hasPrice ? (
              <NumberTicker
                value={value}
                startOnView={false}
                format={(v) =>
                  format.number(v, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
                }
              />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>

          <div className="mt-2 flex items-center justify-end gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => toggleEditor("date")}
              className={cn(
                "tabular-nums outline-none transition-colors",
                openEditor === "date"
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {dateFmt.format(draft.occurredAt)}
            </button>
            <span className="text-muted-foreground">-</span>
            <button
              type="button"
              onClick={() => toggleEditor("time")}
              className={cn(
                "tabular-nums outline-none transition-colors",
                openEditor === "time"
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {timeFmt.format(draft.occurredAt)}
            </button>
          </div>
        </div>

        <Expandable show={openEditor !== null}>
          <div className="px-0.5 pt-3">
            {(openEditor === "date" || openEditor === "time") && (
              <DateTimeWheel
                part={openEditor}
                value={draft.occurredAt}
                onChange={(ms) => setD("occurredAt", ms)}
              />
            )}
            {openEditor === "fee" && (
              <Input
                id="ma-fee"
                inputMode="decimal"
                leftIcon={<span>$</span>}
                value={draft.fee}
                onChange={(v) => setD("fee", v)}
                placeholder={t("feePlaceholder")}
              />
            )}
            {openEditor === "memo" && (
              <textarea
                id="ma-memo"
                rows={3}
                value={draft.memo}
                onChange={(e) => setD("memo", e.target.value)}
                placeholder={t("memoPlaceholder")}
                className={NOTES_CLASS}
              />
            )}
          </div>
        </Expandable>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

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
              {editing ? t("closeWithoutChanges") : t("closeWithoutSaving")}
            </Button>
          </>
        ) : editing ? (
          <>
            <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              type="button"
              className="flex-1"
              onClick={saveEdit}
              disabled={!draftValid(draft) || pending}
            >
              {tc("save")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" className="flex-1" onClick={requestClose}>
              {tc("cancel")}
            </Button>
            <Button
              type="button"
              className="flex-1"
              onClick={submit}
              disabled={!draftValid(draft) || pending}
            >
              {t("submit")}
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
  edit,
  owned,
  onClose,
  onSubmit,
  onEdit,
  pending,
  submitResult,
}: {
  open: boolean;
  defaultToken: PickedToken | null;
  lockToken?: boolean;
  edit?: EditActivityInput | null;
  owned?: readonly TokenOption[];
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => void;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => void;
  pending: boolean;
  submitResult: SubmitResult;
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  return (
    // Portal to body: on mobile the host is a BottomSheet (transform + overflow-hidden), which
    // would clip the fixed MorphingModal.
    <Portal>
      <MorphingModal
        viewId={open ? "activity" : null}
        onClose={() => {}}
        placement={isDesktop ? "center" : "bottom"}
      >
        {open && (
          // Remount on a new edit target / lock / preset token so the draft resets.
          <ActivityForm
            key={
              edit
                ? `edit:${edit.activityId}`
                : `${lockToken ? "lock" : "free"}:${defaultToken?.ticket ?? defaultToken?.symbol ?? "none"}`
            }
            defaultToken={defaultToken}
            lockToken={lockToken}
            edit={edit}
            owned={owned}
            onClose={onClose}
            onSubmit={onSubmit}
            onEdit={onEdit}
            pending={pending}
            submitResult={submitResult}
          />
        )}
      </MorphingModal>
    </Portal>
  );
}
