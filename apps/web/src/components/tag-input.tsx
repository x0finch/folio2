import { cn, SharedLayoutBg } from "@folio/ui";
import { Check, CornerDownLeft, ListChecks, Settings2, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslations } from "use-intl";

interface TagInputItem {
  id: string;
  name: string; // plain name, without `#`
  attached: boolean;
  accountCount: number; // for the delete-confirm copy
  pending?: boolean; // optimistic placeholder without a real id: not clickable / renamable / deletable
}

// Strips a leading `#` the user may type, so the DB only ever holds plain names. Trim before and
// after: " #cold" must lose its space first, and "# cold" its inner space after.
const stripHash = (raw: string) => raw.trim().replace(/^#+/, "").trim();

export interface TagInputProps {
  subtitle?: string;
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
    // An existing name (case-insensitive) is reused and attached rather than created.
    const existing = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    // A still-in-flight placeholder will be attached anyway; resubmitting would hit the unique index.
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
    // Enter while composing (IME) confirms a candidate, not a submit.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "") {
      // Empty backspace detaches the last attached tag.
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
              // max-w-full + inner truncate: long names must ellipsize instead of breaking the flex-wrap
              // container (truncate has no effect on this flex wrapper).
              className={cn(
                "flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
                item.attached
                  ? "border border-foreground text-foreground"
                  : "border border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate">#{item.name}</span>
            </button>
          ))}

          <span
            className={cn(
              "inline-flex flex-1 items-center gap-1.5 rounded-full px-3 py-1.5",
              typing ? "border border-muted-foreground/40 border-dashed" : "",
            )}
            style={{ minWidth: "7rem" }}
          >
            {/* Fixed `#` lead-in; typed `#` is stripped by stripHash on commit. */}
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
  // SharedLayoutBg wraps each child in a block <div z-10>, so the flex row lives in the inner element,
  // otherwise the input and delete button split onto two lines.
  return (
    <SharedLayoutBg className="min-h-24 gap-0.5" inset={8}>
      {items.map((item) => (
        <div key={item.id}>
          {confirmingId === item.id ? (
            <div className="flex items-center gap-2 px-2 py-2">
              {/* title says what is deleted, subtitle the impact */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground text-sm">
                  {t("removeTitle", { name: `#${item.name}` })}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t("removeSubtitle", { count: item.accountCount })}
                </div>
              </div>
              {/* cancel / confirm-delete icon buttons */}
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
              {/* Same fixed `#` lead-in as the input. */}
              <span aria-hidden className="pl-2 text-muted-foreground text-sm">
                #
              </span>
              <input
                key={`${item.id}:${item.name}`}
                defaultValue={item.name}
                disabled={item.pending} // no real id yet
                onBlur={(e) => {
                  const next = stripHash(e.target.value);
                  if (next && next !== item.name) onRename(item.id, next);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
