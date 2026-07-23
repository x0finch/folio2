import type { TokenInfo } from "@folio/tokens";
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
  useMediaQuery,
} from "@folio/ui";
import { CalendarDays, DollarSign, Pencil, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { formatNumber } from "../lib/format-number";
import { useTokenPrice } from "../lib/hooks/use-token-price";
import type { ActivityDraft, DraftTokenRef } from "../lib/manual-types";
import { DateWheel } from "./date-wheel";
import { Portal } from "./portal";
import { TokenCombobox } from "./token-combobox";

// manual 活动的暂存批量录入(A5 F 片 + 交易模型迭代)。布局照参考稿:type 顶部平铺 tab(add/reduce/set)、token 选币、
// Quantity + Price 同行、日期/手续费/备注三枚 chip(fee/notes 点开渐进展开,notes 多行默认一行)、Total 汇总卡、主按钮。
// 价格默认取当前选中币种市价(useTokenPrice 回填,用户改动后不再覆写)。price/fee 为成本基元数据(不参与数量折叠,
// 供 Total 与后续 P/L 用;历史价见 #148)。「再添加一笔」压入待提交列表、「提交」= 列表 + 当前草稿。
// **backdrop 不关**(onClose 传 no-op),仅 ✕ 关;有未保存内容时 ✕ 就地出「不保存关闭 / 继续」两按钮。

// beUI EASE_OUT 动效曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Kind = ActivityDraft["kind"];

// 编辑既有活动的入参:定位(tokenId/activityId)+ 锁定 token + 预填各字段。
export interface EditActivityInput {
  tokenId: string;
  activityId: string;
  token: DraftTokenRef;
  kind: Kind;
  amount: number;
  price?: number;
  fee?: number;
  occurredAt: number;
  memo?: string;
}

// 编辑保存的 patch(store 保留 id/createdAt)。
export interface ActivityPatch {
  kind: Kind;
  amount: number;
  occurredAt: number;
  memo?: string;
  price?: number;
  fee?: number;
}

interface DraftForm {
  token: DraftTokenRef | null;
  kind: Kind;
  amount: string;
  price: string;
  fee: string;
  occurredAt: number;
  memo: string;
}

const KINDS: Kind[] = ["add", "reduce", "set"];

// 备注多行输入:无 beUI Textarea 组件 → token-only 本地 textarea,镜像 Input 的描边/焦点样式;
// field-sizing:content 随内容自增,默认一行(min-h-11),封顶 max-h-32。
const NOTES_CLASS =
  "w-full resize-none rounded-2xl border border-border bg-transparent px-3.5 py-2.5 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 [field-sizing:content] min-h-11 max-h-32";

// 手续费/备注 chip:窄 pill,点开渐进展开输入;激活态(已展开)着 bg-muted。
const CHIP_CLASS =
  "flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border px-3.5 text-muted-foreground text-sm outline-none transition-colors hover:border-foreground/40 hover:text-foreground";

// 展开/收起容器:height 0↔auto + opacity(EASE_OUT 0.22s),与 DateWheel 原有开合同款。日期/手续费/备注三处共用。
// 纯 Framer AnimatePresence(收起即 exit 卸载 → 直接作 flex 兄弟也不留幽灵间距);开合由外部布尔驱动。
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

function midnightToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// DraftTokenRef → TokenCombobox 可显示的 TokenInfo(仅展示,不校验 ref.source)。无 identifier → null(走手动模式)。
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

// price 字符串 → number(仅正有限数),否则 undefined。fee 同理但 set 种类不带 fee。
function numOrUndef(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// 草稿是否与初值一致(用于判定「是否真被改动」→ 决定 ✕ 是否需要确认)。token 以身份(identifier/symbol)比对。
function sameDraft(a: DraftForm, b: DraftForm): boolean {
  const tokA = a.token?.identifier ?? a.token?.symbol ?? null;
  const tokB = b.token?.identifier ?? b.token?.symbol ?? null;
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
  onClose,
  onSubmit,
  onEdit,
}: {
  defaultToken: DraftTokenRef | null;
  lockToken?: boolean; // 从 token 行「编辑」进入:锁定该 token,不可改
  edit?: EditActivityInput | null; // 编辑既有活动:预填 + 锁定 token + 单条保存(非批量)
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => Promise<{ ok: boolean }>;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations("Activity");
  const tc = useTranslations("Common");
  const ta = useTranslations("Accounts");
  const format = useFormatter();
  const { fetchPrice } = useTokenPrice();

  // 编辑态:锁定 token、无批量(pending/再添加一笔),底部换成 取消/保存。
  const editing = Boolean(edit);
  const lockedToken = edit?.token ?? defaultToken;
  const locked = editing || lockToken;

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
          // token 行「编辑」进入默认「校准」(set,直接改到目标余额);plus 新增默认「增加」(add)。均可后续再改。
          kind: lockToken ? "set" : "add",
          amount: "",
          // 价格默认取选中币种当前市价(锁定/预选 token 自带 unitPrice)。
          price: defaultToken && defaultToken.unitPrice > 0 ? String(defaultToken.unitPrice) : "",
          fee: "",
          occurredAt: midnightToday(),
          memo: "",
        };

  const [pending, setPending] = useState<DraftForm[]>([]);
  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [picked, setPicked] = useState<TokenInfo | null>(toTokenInfo(lockedToken));
  const [manualMode, setManualMode] = useState(Boolean(lockedToken && !lockedToken.identifier));
  const [showWheel, setShowWheel] = useState(false);
  const [showFee, setShowFee] = useState(Boolean(edit?.fee));
  const [showMemo, setShowMemo] = useState(Boolean(edit?.memo));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);
  // 用户是否手改过 price → 是则市价异步回填不再覆写(ref 避免闭包读旧值)。编辑态预填价格,视作已定。
  const priceTouched = useRef(Boolean(edit));
  // 表单初值快照(挂载一次):判定草稿是否真被改动 → 决定 ✕ 是否需要确认(编辑态预填不算脏)。
  const initialRef = useRef<DraftForm | null>(null);
  let initialDraft = initialRef.current;
  if (initialDraft === null) {
    initialDraft = emptyDraft();
    initialRef.current = initialDraft;
  }

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
    priceTouched.current = false;
    setDraft((d) => ({
      ...d,
      token: {
        symbol: tok.symbol.toUpperCase(),
        identifier: id,
        logo: tok.logo,
        name: tok.name,
        unitPrice: 0,
      },
      price: "",
    }));
    // 市价异步回填(竞态守卫):仍指向同一 token 才写;未手改 price 时一并回填价格字段。
    fetchPrice(id, (p) =>
      setDraft((d) => {
        if (d.token?.identifier !== id) return d;
        return {
          ...d,
          token: { ...d.token, unitPrice: p },
          price: priceTouched.current ? d.price : String(p),
        };
      }),
    );
  };

  // 脏 = 有待提交项 或 草稿相对初值被改动过(编辑态未改则不脏 → ✕ 直接关,不弹确认)。
  const dirty = pending.length > 0 || !sameDraft(draft, initialDraft);

  // 载入某个待提交项到草稿(原位编辑),同步选币/展开态。
  const loadDraft = (d: DraftForm) => {
    setDraft(d);
    setPicked(toTokenInfo(d.token));
    setManualMode(Boolean(d.token && !d.token.identifier));
    setShowWheel(false);
    setShowFee(d.fee.trim() !== "");
    setShowMemo(d.memo.trim() !== "");
    priceTouched.current = true;
  };

  const resetAfterStage = () => {
    // 保留 token/日期/价格/种类(便于连续录同一 token),清 amount/fee/memo 并收起 fee/notes。
    setDraft((d) => ({ ...d, amount: "", fee: "", memo: "" }));
    setShowFee(false);
    setShowMemo(false);
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
        price: numOrUndef(d.price),
        // set(校准)不涉手续费。
        fee: d.kind === "set" ? undefined : numOrUndef(d.fee),
      }));
  };

  // 提交/保存改走服务端(T4)→ 异步。busy 期间禁用按钮防重复提交;超支(res.ok=false)在 modal 内报错。
  // 成功由父级 invalidate + 关闭 modal;本组件随之卸载,finally 的 setBusy 是无害 no-op(React 18)。
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const drafts = toDrafts();
    if (drafts.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSubmit(drafts);
      if (!res.ok) setError(t("reduceTooMuch"));
    } finally {
      setBusy(false);
    }
  };

  // 编辑态保存:把当前草稿转成 patch,交回父级更新该笔(保留 id/createdAt),超支则报错。
  const saveEdit = async () => {
    if (!edit || !onEdit || !draftValid(draft) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onEdit(edit.tokenId, edit.activityId, {
        kind: draft.kind,
        amount: Number(draft.amount),
        occurredAt: draft.occurredAt,
        memo: draft.memo.trim() || undefined,
        price: numOrUndef(draft.price),
        fee: draft.kind === "set" ? undefined : numOrUndef(draft.fee),
      });
      if (!res.ok) setError(t("reduceTooMuch"));
    } finally {
      setBusy(false);
    }
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

  // 价值预览 = 数量 × 单价(中性,不含 fee)。三种种类通用:add/reduce 是本次变动价值,set 是目标余额价值。
  const qty = Number(draft.amount);
  const priceNum = Number(draft.price);
  const showValue =
    draft.amount.trim() !== "" &&
    Number.isFinite(qty) &&
    qty > 0 &&
    numOrUndef(draft.price) != null; // 记录了单价即显(含 0 = 零成本);空/非法不显
  const value = qty * priceNum;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-base">
          {editing ? t("editActivityTitle") : t("addActivityTitle")}
        </h2>
        <button
          type="button"
          onClick={requestClose}
          aria-label={tc("close")}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* type:顶部平铺 segment tab(中性 bg-muted 指示器,把 primary 留给主 CTA) */}
      <Tabs
        value={draft.kind}
        onValueChange={(v) => setD("kind", v as Kind)}
        variant="segment"
        className="w-full"
      >
        {/* [&>div]:flex-1 让每个 trigger 包裹层(beUI 未导出其 className)等分 → 三项平均布局;button 改 w-full 填满 */}
        <TabsList className="w-full [&>div]:flex-1">
          {KINDS.map((k) => (
            <TabsTrigger
              key={k}
              value={k}
              // 中性 bg-muted 指示器(把 primary 留给主 CTA);默认 active 文字是 text-primary-foreground(本主题偏暗),
              // 在暗色 muted 药丸上不可读 → 仅对选中态覆写为 text-foreground(aria-selected 变体,不动未选中态)。
              className="w-full aria-selected:text-foreground"
              indicatorClassName="bg-muted"
            >
              {t(k)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* token:锁定时静态展示(token 行编辑 / 活动编辑进入);否则 CGK 全量选币(记活动即可建 token) */}
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
          onChange={onPick}
          onManual={(q) => {
            setManualMode(true);
            setPicked(null);
            setD("token", { symbol: q.toUpperCase(), unitPrice: 0 });
          }}
        />
      )}

      {/* Quantity + Price 同行 */}
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

      {/* chips 行 + 三个展开区(日期/手续费/备注)同组,组内无 gap → 收起项(height 0)不留幽灵间距;
          各展开区自带 pt-3 上间距(计入动画高度,收起即归 0)。fee/notes 点开渐进展开,同 wheel 动效。 */}
      <div ref={dateRef} className="flex flex-col">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowWheel((s) => !s)}
            className={cn(
              "flex h-11 flex-1 items-center gap-2 rounded-full border px-3.5 text-sm outline-none transition-colors",
              showWheel ? "border-foreground/40" : "border-border hover:border-foreground/40",
            )}
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {format.dateTime(new Date(draft.occurredAt), { dateStyle: "medium" })}
            </span>
          </button>
          {draft.kind !== "set" && (
            <button
              type="button"
              onClick={() => {
                setShowWheel(false);
                setShowFee((s) => !s);
              }}
              className={cn(CHIP_CLASS, showFee && "border-foreground/40 bg-muted text-foreground")}
            >
              <DollarSign className="size-4 shrink-0" />
              {t("feeLabel")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setShowWheel(false);
              setShowMemo((s) => !s);
            }}
            className={cn(CHIP_CLASS, showMemo && "border-foreground/40 bg-muted text-foreground")}
          >
            <Pencil className="size-4 shrink-0" />
            {t("memoLabel")}
          </button>
        </div>
        <Expandable show={showWheel}>
          {/* pt-3 上间距计入动画高度;px-0.5 给焦点 ring 让位,免被 overflow-hidden 裁掉 */}
          <div className="px-0.5 pt-3">
            <DateWheel value={draft.occurredAt} onChange={(ms) => setD("occurredAt", ms)} />
          </div>
        </Expandable>

        {/* fee 输入(仅 add/reduce,chip 点开) */}
        <Expandable show={draft.kind !== "set" && showFee}>
          <div className="px-0.5 pt-3">
            <Input
              id="ma-fee"
              inputMode="decimal"
              leftIcon={<span>$</span>}
              value={draft.fee}
              onChange={(v) => setD("fee", v)}
              placeholder={t("feePlaceholder")}
            />
          </div>
        </Expandable>

        {/* notes 多行(chip 点开,默认一行) */}
        <Expandable show={showMemo}>
          <div className="px-0.5 pt-3">
            <textarea
              id="ma-memo"
              rows={1}
              value={draft.memo}
              onChange={(e) => setD("memo", e.target.value)}
              placeholder={t("memoPlaceholder")}
              className={NOTES_CLASS}
            />
          </div>
        </Expandable>
      </div>

      {/* 价值预览卡(三种种类通用;Adjust 显示目标余额价值)。数字用 NumberTicker 滚动动画;
          它内部四舍五入到整数,故格式化到整美元(预览用,足够)。startOnView=false → 弹层内即刻就绪。 */}
      {showValue && (
        <div className="rounded-2xl bg-muted px-4 py-3">
          <p className="text-muted-foreground text-sm">{t("valuePreview")}</p>
          <div className="font-bold text-2xl">
            <NumberTicker
              value={value}
              startOnView={false}
              format={(v) =>
                format.number(v, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
              }
            />
          </div>
        </div>
      )}

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
              {/* 价值(数量 × 单价);记录了单价才显(含 0 = 零成本),空/非法则不显 */}
              {numOrUndef(d.price) != null && (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {format.number(Number(d.amount) * Number(d.price), {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 2,
                  })}
                </span>
              )}
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
              disabled={!draftValid(draft) || busy}
            >
              {tc("save")}
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
            <Button
              type="button"
              className="flex-1"
              onClick={submit}
              disabled={submitCount === 0 || busy}
            >
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
  edit,
  onClose,
  onSubmit,
  onEdit,
}: {
  open: boolean;
  defaultToken: DraftTokenRef | null; // 默认选中(最新一笔活动的 token,或 token 行进入时锁定的 token)
  lockToken?: boolean; // token 行「编辑」进入:锁定 token 不可改
  edit?: EditActivityInput | null; // 活动行「编辑」进入:预填既有活动、单条保存
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => Promise<{ ok: boolean }>;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => Promise<{ ok: boolean }>;
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
          // key:切换编辑目标 / 锁定 / 预选 token 时重挂,草稿态按新入参重置。
          <ActivityForm
            key={
              edit
                ? `edit:${edit.activityId}`
                : `${lockToken ? "lock" : "free"}:${defaultToken?.identifier ?? defaultToken?.symbol ?? "none"}`
            }
            defaultToken={defaultToken}
            lockToken={lockToken}
            edit={edit}
            onClose={onClose}
            onSubmit={onSubmit}
            onEdit={onEdit}
          />
        )}
      </MorphingModal>
    </Portal>
  );
}
