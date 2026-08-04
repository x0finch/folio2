import { cn, SharedLayoutBg } from "@folio/ui";
import { Check, CornerDownLeft, ListChecks, Settings2, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslations } from "use-intl";

// 「打标签」的标签输入框(ADR 0034,照本 epic 定稿的可视化稿)。**纯展示 + 本地交互态**(draft / manage /
// 删除确认),不含任何服务端逻辑 —— attach/detach/create/rename/delete 全经 props 回调,由 AccountTagsModal
// 接线。这样它可复用、可单测,且乐观更新的责任集中在调用方(memory:行为经 hook/props 复用,不包组件)。

interface TagInputItem {
  id: string;
  name: string; // 纯名字(不含 `#`)—— `#` 只在渲染时贴
  attached: boolean; // 本账户是否已打
  accountCount: number; // 打了这个 Tag 的账户数(删除确认文案用)
  pending?: boolean; // 新建的乐观占位:样子与常规 chip 一致,但还没有真 id → 不接受点击/改名/删除
}

// 用户可能顺手把 `#` 也敲进去(界面到处显 `#name`)→ 吞掉前导 `#` 再存,库里永远是纯名字。
// **先 trim 再剥**,且剥完再 trim:粘进来的 " #cold" 若先剥,`^#+` 压根匹配不上(首字符是空格),
// `#` 就跟着进库了;"# cold" 则要剥完再 trim 掉中间那个空格。
const stripHash = (raw: string) => raw.trim().replace(/^#+/, "").trim();

export interface TagInputProps {
  subtitle?: string; // 账户名(标题下方)
  items: TagInputItem[];
  onToggle: (tagId: string, next: boolean) => void;
  onCreate: (name: string) => void;
  onRename: (tagId: string, name: string) => void;
  onDelete: (tagId: string) => void;
}

export function TagInput({
  subtitle,
  items,
  onToggle,
  onCreate,
  onRename,
  onDelete,
}: TagInputProps) {
  const t = useTranslations("Tags");
  const tc = useTranslations("Common");
  const [draft, setDraft] = useState("");
  const [manage, setManage] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const typing = draft.trim().length > 0;

  const commit = () => {
    const name = stripHash(draft);
    if (!name) return;
    // 输入已存在的名(忽略大小写)= 复用并打上,而非新建;否则新建(调用方会自动打到本账户)。
    const existing = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    // 命中的是还在飞的新建占位 → 它本就会被打上,重复提交只会撞唯一索引报错,这里直接吞掉。
    if (existing?.pending) {
      setDraft("");
      return;
    }
    if (existing) onToggle(existing.id, true);
    else onCreate(name);
    setDraft("");
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组字中,Enter 是「确认候选词」而非提交 —— isComposing 时放行,别误建标签。
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "") {
      // 空退格:取消最后一个已打上的 Tag(标签输入框的老习惯)。
      const lastAttached = [...items].reverse().find((i) => i.attached);
      if (lastAttached) onToggle(lastAttached.id, false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-base text-foreground">{t("title")}</div>
          {subtitle && <div className="mt-0.5 text-muted-foreground text-sm">{subtitle}</div>}
        </div>
        <button
          type="button"
          onClick={() => {
            setManage((m) => !m);
            setConfirmingId(null);
            setDraft("");
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
        >
          {manage ? <ListChecks className="size-3.5" /> : <Settings2 className="size-3.5" />}
          {manage ? t("done") : t("manage")}
        </button>
      </div>

      {manage ? (
        <ManageList
          items={items}
          confirmingId={confirmingId}
          setConfirmingId={setConfirmingId}
          onRename={onRename}
          onDelete={onDelete}
          t={t}
          tc={tc}
        />
      ) : (
        <div className="flex min-h-24 flex-wrap content-start gap-2 rounded-xl border border-border p-2">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.attached}
              disabled={item.pending}
              onClick={() => onToggle(item.id, !item.attached)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
                item.attached
                  ? "border border-foreground text-foreground"
                  : "border border-border text-muted-foreground hover:text-foreground",
              )}
            >
              #{item.name}
            </button>
          ))}

          <span
            className={cn(
              "inline-flex flex-1 items-center gap-1.5 rounded-full px-3 py-1.5",
              typing ? "border border-muted-foreground/40 border-dashed" : "",
            )}
            style={{ minWidth: "7rem" }}
          >
            {/* 固定 `#` 导引:告诉用户「这里输的是标签」,但它不是输入内容 —— 用户打纯文字,
                多敲的 `#` 在 commit 时被 stripHash 吞掉。 */}
            <span aria-hidden className="shrink-0 text-muted-foreground text-sm">
              #
            </span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={items.length ? t("addPlaceholder") : t("addFirstPlaceholder")}
              className="min-w-10 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
            />
            {typing && (
              <button
                type="button"
                aria-label={t("addPlaceholder")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit();
                }}
                className="flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <CornerDownLeft className="size-4" />
              </button>
            )}
          </span>
        </div>
      )}

      <p className="text-muted-foreground text-xs">{manage ? t("manageHint") : t("hint")}</p>
    </div>
  );
}

function ManageList({
  items,
  confirmingId,
  setConfirmingId,
  onRename,
  onDelete,
  t,
  tc,
}: {
  items: TagInputItem[];
  confirmingId: string | null;
  setConfirmingId: (id: string | null) => void;
  onRename: (tagId: string, name: string) => void;
  onDelete: (tagId: string) => void;
  t: ReturnType<typeof useTranslations<"Tags">>;
  tc: ReturnType<typeof useTranslations<"Common">>;
}) {
  // 无卡片、无描边:各行共享 SharedLayoutBg 的 hover 高亮垫底(UI 微调),去掉行首色点。
  // SharedLayoutBg 会把每个子元素的 children 再套一层 block <div z-10>,故真正的 flex 行放在**内层**一格,
  // 否则 input 与删除钮会被那层 block 拆成上下两行(实测坑)。
  return (
    <SharedLayoutBg className="min-h-24 gap-0.5" inset={8}>
      {items.map((item) => (
        <div key={item.id}>
          {confirmingId === item.id ? (
            <div className="flex items-center gap-2 px-2 py-2">
              {/* title / subtitle 两行:标题说删哪个,副标题说影响面 —— 不再挤成一段长句折行。 */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground text-sm">
                  {t("removeTitle", { name: `#${item.name}` })}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t("removeSubtitle", { count: item.accountCount })}
                </div>
              </div>
              {/* 二次确认用图标钮:叉 = 取消,勾 = 确认删除(destructive 色)。 */}
              <button
                type="button"
                aria-label={tc("cancel")}
                onClick={() => setConfirmingId(null)}
                className="flex shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
              <button
                type="button"
                aria-label={tc("delete")}
                onClick={() => {
                  onDelete(item.id);
                  setConfirmingId(null);
                }}
                className="flex shrink-0 rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10"
              >
                <Check className="size-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 px-2 py-1">
              {/* 与打标签输入框同款固定 `#` 导引:改名同样只输纯名字,多敲的 `#` 被吞。 */}
              <span aria-hidden className="pl-2 text-muted-foreground text-sm">
                #
              </span>
              <input
                key={`${item.id}:${item.name}`}
                defaultValue={item.name}
                disabled={item.pending} // 占位还没有真 id,改名/删除都无从谈起
                onBlur={(e) => {
                  const next = stripHash(e.target.value);
                  if (next && next !== item.name) onRename(item.id, next);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return; // 输入法组字中不提交改名
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="-ml-1.5 h-8 flex-1 rounded-md bg-transparent px-1 text-foreground text-sm outline-none focus:bg-muted"
              />
              <button
                type="button"
                aria-label={`${tc("delete")} ${item.name}`}
                disabled={item.pending}
                onClick={() => setConfirmingId(item.id)}
                className="flex shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          )}
        </div>
      ))}
    </SharedLayoutBg>
  );
}
