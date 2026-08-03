import { cn } from "@folio/ui";
import { Check, CornerDownLeft, SlidersHorizontal, Trash2 } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslations } from "use-intl";

// 「打标签」的标签输入框(ADR 0034,照本 epic 定稿的可视化稿)。**纯展示 + 本地交互态**(draft / manage /
// 删除确认),不含任何服务端逻辑 —— attach/detach/create/rename/delete 全经 props 回调,由 AccountTagsModal
// 接线。这样它可复用、可单测,且乐观更新的责任集中在调用方(memory:行为经 hook/props 复用,不包组件)。

interface TagInputItem {
  id: string;
  name: string;
  color: string; // var(--chart-N)(tagColor 给);只引 design token
  attached: boolean; // 本账户是否已打
  accountCount: number; // 打了这个 Tag 的账户数(删除确认文案用)
}

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
    const name = draft.trim();
    if (!name) return;
    // 输入已存在的名(忽略大小写)= 复用并打上,而非新建;否则新建(调用方会自动打到本账户)。
    const existing = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
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
          <SlidersHorizontal className="size-3.5" />
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
              onClick={() => onToggle(item.id, !item.attached)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
                item.attached ? "text-foreground" : "border border-border text-muted-foreground",
              )}
              style={item.attached ? { border: `1.5px solid ${item.color}` } : undefined}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={
                  item.attached
                    ? { background: item.color }
                    : { border: `1.5px solid ${item.color}` }
                }
              />
              {item.name}
              {item.attached && <Check className="size-3.5" style={{ color: item.color }} />}
            </button>
          ))}

          <span
            className={cn(
              "inline-flex flex-1 items-center gap-1.5 rounded-full px-3 py-1.5",
              typing ? "border border-muted-foreground/40 border-dashed" : "",
            )}
            style={{ minWidth: "7rem" }}
          >
            {typing && <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground/50" />}
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
  return (
    <div className="min-h-24 rounded-xl border border-border p-1">
      {items.map((item) =>
        confirmingId === item.id ? (
          <div
            key={item.id}
            className="flex items-center gap-2 border-destructive/60 border-b px-1 py-2 last:border-b-0"
          >
            <span className="flex-1 text-foreground text-sm">
              {t("removeConfirm", { name: item.name, count: item.accountCount })}
            </span>
            <button
              type="button"
              onClick={() => setConfirmingId(null)}
              className="rounded-md px-2.5 py-1 text-sm transition-colors hover:bg-muted"
            >
              {tc("cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                onDelete(item.id);
                setConfirmingId(null);
              }}
              className="rounded-md px-2.5 py-1 text-destructive text-sm transition-colors hover:bg-destructive/10"
            >
              {tc("delete")}
            </button>
          </div>
        ) : (
          <div
            key={item.id}
            className="flex items-center gap-2.5 border-border border-b px-1 py-1.5 last:border-b-0"
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
            <input
              key={`${item.id}:${item.name}`}
              defaultValue={item.name}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== item.name) onRename(item.id, next);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // 输入法组字中不提交改名
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="h-8 flex-1 rounded-md bg-transparent px-2 text-foreground text-sm outline-none focus:bg-muted"
            />
            <button
              type="button"
              aria-label={`${tc("delete")} ${item.name}`}
              onClick={() => setConfirmingId(item.id)}
              className="flex shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ),
      )}
    </div>
  );
}
