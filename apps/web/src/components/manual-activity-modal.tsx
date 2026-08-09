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
import { useLocalDateFormat } from "../lib/hooks/use-local-date-format";
import { useTokenPrice } from "../lib/hooks/use-token-price";
import type { ActivityDraft, PickedToken } from "../lib/manual-types";
import type { TokenOption } from "../lib/token-option";
import { DateTimeWheel } from "./date-time-wheel";
import { IconButton } from "./icon-button";
import { Portal } from "./portal";
import { TokenCombobox } from "./token-combobox";

// manual 活动录入(单笔;A5 F 片 + 交易模型迭代)。布局:type 顶部平铺 tab(add/reduce/set)、token 选币、
// Quantity + Price 同行、常驻「价值预览」卡(右上 手续费/备注 ghost 图标、右下 无边框日期-时间小字)、主按钮。
// 描述项点开在预览卡外展开对应编辑器(日期/时间=滚轮各自打开、手续费=输入、备注=多行),单开、点外部/失焦收起。
// 价格默认取当前选中币种市价(useTokenPrice 回填,用户改动后不再覆写)。price/fee 为成本基元数据(不参与数量折叠,
// 供预览与后续 P/L 用;历史价见 #148)。一次录一笔:「提交」提交当前草稿、「取消」关闭(脏则先确认)。
// **backdrop 不关**(onClose 传 no-op),仅 ✕ 关;有未保存内容时 ✕ 就地出「继续 / 不保存」两按钮。

// beUI EASE_OUT 动效曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

type Kind = ActivityDraft["kind"];

// 编辑既有活动的入参:定位(tokenId/activityId)+ 锁定 token + 预填各字段。
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

// 上一次提交的结果,由父级(持有 mutation 的那一层)给。
// **两种失败要分开**:`over` 是服务端照常返回的业务性拒绝(卖超,改个数字再来);
// `failed` 是这次写压根没成(网络断了 / server fn 抛了)。糊成一句「操作失败」会让前者变得不可行动。
export type SubmitResult = "over" | "failed" | null;

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
  token: PickedToken | null;
  kind: Kind;
  amount: string;
  price: string;
  fee: string;
  occurredAt: number;
  memo: string;
}

const KINDS: Kind[] = ["add", "reduce", "set"];

// 备注多行输入:无 beUI Textarea 组件 → token-only 本地 textarea,镜像 Input 的描边/焦点样式;
// field-sizing:content 随内容自增,默认约 3 行(min-h-24),封顶 max-h-32。
const NOTES_CLASS =
  "w-full resize-none rounded-2xl border border-border bg-transparent px-3.5 py-2.5 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 [field-sizing:content] min-h-24 max-h-32";

// 预览卡右上的 ghost 图标(手续费/备注):透明底、hover 圆形微底;有值着 text-primary,展开态着 bg-background。
const GHOST_ICON =
  "flex size-7 items-center justify-center rounded-full outline-none transition-colors hover:bg-background/60";

// 预览卡日期/时间小字(分开点击):日期 = 2 位年 + 月日(裁到 2 位年;滚轮里用完整年份),时间 = 时:分:秒。
const DATE_FMT = { year: "2-digit", month: "short", day: "numeric" } as const;
const TIME_FMT = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } as const;

// 展开/收起容器:height 0↔auto + opacity(EASE_OUT 0.22s)。预览卡外的单一编辑区(日期时间/手续费/备注)用它开合。
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

// PickedToken → TokenCombobox 能显示的一项(仅展示)。没有票 = 用户当初是手敲的 symbol → null(手动模式)。
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

// price 字符串 → number(仅正有限数),否则 undefined。fee 同理但 set 种类不带 fee。
function numOrUndef(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// 草稿是否与初值一致(用于判定「是否真被改动」→ 决定 ✕ 是否需要确认)。token 以身份(票/symbol)比对。
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
  lockToken?: boolean; // 从 token 行「编辑」进入:锁定该 token,不可改
  edit?: EditActivityInput | null; // 编辑既有活动:预填 + 锁定 token + 单条保存(非批量)
  owned?: readonly TokenOption[]; // 选币「已有代币」组:该侧边栏账户当前已有的币(#269)
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => void;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => void;
  /** 写在飞 —— 禁提交/保存钮。这一份由父的 mutation 持有,表单不再自己数。 */
  pending: boolean;
  /** 上一次提交的结果:`over` = 卖超 / `failed` = 写失败 / null = 没有可报的。 */
  submitResult: SubmitResult;
}) {
  const t = useTranslations("Activity");
  const tc = useTranslations("Common");
  const ta = useTranslations("Accounts");
  const format = useFormatter();
  const { fetchPrice } = useTokenPrice();

  // manual 活动时间按本地时区展示(见 useLocalDateFormat;与 DateTimeWheel 的本地墙钟一致)。
  const dateFmt = useLocalDateFormat(DATE_FMT);
  const timeFmt = useLocalDateFormat(TIME_FMT);

  // 编辑态(edit 既有活动):锁定 token,底部换成 取消/保存(单条 patch,非新增)。
  const editing = Boolean(edit);
  const lockedToken = edit?.token ?? defaultToken;
  const locked = editing || lockToken;

  // 新活动默认发生时刻 = 打开 modal 的此刻,floor 到秒(occurredAt 精确到秒)。用户可经 DateTimeWheel 改。
  // 真实时刻确保同一天多笔按先后有序排列 + 折叠;同秒极少见,再靠 createdAt(入库序)兜底。
  // useRef 固化到一次打开(emptyDraft 会被调用多次:initialRef 快照 + draft 初值,须取同一值,否则 dirty 误判)。
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
          // token 行「编辑」进入默认「校准」(set,直接改到目标余额);plus 新增默认「增加」(add)。均可后续再改。
          kind: lockToken ? "set" : "add",
          amount: "",
          // 价格默认取选中币种当前市价(锁定/预选 token 自带 unitPrice)。
          price: defaultToken && defaultToken.unitPrice > 0 ? String(defaultToken.unitPrice) : "",
          fee: "",
          occurredAt: openedAtRef.current,
          memo: "",
        };

  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [picked, setPicked] = useState<TokenOption | null>(toOption(lockedToken));
  const [manualMode, setManualMode] = useState(Boolean(lockedToken && !lockedToken.ticket));
  // 单开编辑器:日期 / 时间 / 手续费 / 备注 互斥,点开一个在预览卡外展开,点外部或失焦收起(日期与时间也不同时开)。
  const [openEditor, setOpenEditor] = useState<"date" | "time" | "fee" | "memo" | null>(null);
  const [closing, setClosing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  // 用户是否手改过 price → 是则市价异步回填不再覆写(ref 避免闭包读旧值)。编辑态预填价格,视作已定。
  const priceTouched = useRef(Boolean(edit));
  // 表单初值快照(挂载一次):判定草稿是否真被改动 → 决定 ✕ 是否需要确认(编辑态预填不算脏)。
  const initialRef = useRef<DraftForm | null>(null);
  let initialDraft = initialRef.current;
  if (initialDraft === null) {
    initialDraft = emptyDraft();
    initialRef.current = initialDraft;
  }

  // 编辑器展开时点组件外 → 收起(失焦自动关)。previewRef 包住预览卡 + 卡外编辑区,内部点击不收。
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
    // 市价异步回填(竞态守卫):仍指向同一 token 才写;未手改 price 时一并回填价格字段。
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

  // 脏 = 草稿相对初值被改动过(未改则 ✕ 直接关,不弹确认)。
  const dirty = !sameDraft(draft, initialDraft);

  // 当前草稿 → 提交项(单条;server createManualActivities 仍收数组,此表单一次录一笔,createdAt 服务端重定)。
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
        fee: draft.kind === "set" ? undefined : numOrUndef(draft.fee), // set(校准)不涉手续费
      },
    ];
  };

  // 提交/保存是**发起**,不是等待:交给父级的 mutation,在飞与结果都由 `pending` / `submitResult` 回来。
  // 以前这里 `await onSubmit(...)` 又只有 try/finally —— 父级那句裸 await 一旦抛(网络断了、
  // server fn 500),异常穿过 finally 逃出 submit(),变成一条没人接的 unhandled rejection:
  // 按钮恢复可点,但**画面上什么都不会说**。现在写失败会走 `submitResult === "failed"` 报出来。
  const submit = () => {
    const drafts = toDrafts();
    if (drafts.length === 0 || pending) return;
    onSubmit(drafts);
  };

  // 编辑态保存:把当前草稿转成 patch,交回父级更新该笔(保留 id/createdAt)。
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

  // 卖超与写失败是两回事:前者是服务端**照常返回**的业务性拒绝(数字不对,改了再来),
  // 后者是这次写压根没成。文案分开,别都糊成一句「操作失败」。
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

  // 价值预览 = 数量 × 单价(中性,不含 fee)。卡常驻;但**未记单价**时数字显「—」而非 $0
  // (避免把「没填价」误显成「价值为 0」);记了价(含 0)才显具体金额。
  const qty = Number(draft.amount);
  const priceNum = Number(draft.price);
  const hasPrice = numOrUndef(draft.price) != null;
  const value = Number.isFinite(qty * priceNum) ? qty * priceNum : 0;

  // 描述项已填态(图标着色):手续费记了值(含 0)/ 备注非空。set 不涉手续费。
  const feeSet = numOrUndef(draft.fee) != null;
  const memoSet = draft.memo.trim() !== "";
  // 点开/收起单一编辑器;切到 set 时若手续费编辑器开着则一并收(set 不涉手续费)。
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

      {/* type:顶部平铺 segment tab(中性 bg-muted 指示器,把 primary 留给主 CTA) */}
      <Tabs
        value={draft.kind}
        onValueChange={(v) => {
          setD("kind", v as Kind);
          if (v === "set" && openEditor === "fee") setOpenEditor(null);
        }}
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
          owned={owned}
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

      {/* 常驻价值预览卡 + 卡外单一编辑区(previewRef 包住二者 → 内部点击不收起)。
          右上 ghost 图标 = 手续费(仅 add/reduce)/ 备注,右下无边框小字 = 日期时间;点任一在卡外展开对应编辑器。 */}
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

          {/* 价值 = 数量 × 单价(NumberTicker 内部取整 → 格式化到整美元,预览足够);未记单价则显「—」。 */}
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

          {/* 日期 / 时间:独立一行右对齐(与价值留足间隔,长数字也不重叠);日期、时间分开点击,各开各的滚轮,用 - 分隔。 */}
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

        {/* 卡外单一编辑区:px-0.5 给焦点 ring 让位;pt-3 计入动画高度,收起即归 0。 */}
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

      {/* 底部动作:关闭态 → 继续/放弃;编辑态 → 取消/保存;否则 → 取消/提交(单笔录入,无批量暂存)。 */}
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
  defaultToken: PickedToken | null; // 默认选中(最新一笔活动的 token,或 token 行进入时锁定的 token)
  lockToken?: boolean; // token 行「编辑」进入:锁定 token 不可改
  edit?: EditActivityInput | null; // 活动行「编辑」进入:预填既有活动、单条保存
  owned?: readonly TokenOption[]; // 选币「已有代币」组:该侧边栏账户当前已有的币(#269)
  onClose: () => void;
  onSubmit: (drafts: ActivityDraft[]) => void;
  onEdit?: (tokenId: string, activityId: string, patch: ActivityPatch) => void;
  pending: boolean;
  submitResult: SubmitResult;
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
