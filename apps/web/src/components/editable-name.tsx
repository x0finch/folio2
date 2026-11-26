import { Button, cn, Input, Tooltip } from "@folio/ui";
import { Pencil } from "@folio/ui/icons";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";

// Inline name editing: click to edit, Enter submits, cancel restores. `editing` is controlled so
// the parent can adjust surrounding UI. The parent's onSave does the write and failure toast; a
// throw keeps edit mode open for retry.
export function EditableName({
  value,
  editing,
  onEditingChange,
  onSave,
  displayClassName,
  placeholder,
  className,
  children,
  tooltip = true,
}: {
  value: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (name: string) => Promise<void> | void;
  /** Font size/weight of the display state. */
  displayClassName?: string;
  placeholder?: string;
  className?: string;
  /** Content after the name in display state (e.g. a badge); hidden while editing. */
  children?: ReactNode;
  /** "Click to edit" tooltip; clipped inside overflow-hidden containers (e.g. SwipeableList rows), so can be turned off. */
  tooltip?: boolean;
}) {
  const tc = useTranslations("Common");
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);

  // Reseed the draft from the latest value on each entry to edit mode.
  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  async function submit() {
    const name = draft.trim();
    if (!name || name === value) {
      onEditingChange(false); // empty / unchanged: exit without writing
      return;
    }
    setPending(true);
    try {
      await onSave(name);
      onEditingChange(false); // only on success; a throw keeps edit mode for retry
    } catch {
      // onSave owns the failure toast; stay in edit mode
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <form
        className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={setDraft}
          classNames={{ field: "h-8" }}
        />
        <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
          {pending ? tc("verifying") : tc("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onEditingChange(false)}>
          {tc("cancel")}
        </Button>
      </form>
    );
  }

  // Discoverability: fine pointers get a hover tooltip, coarse (touch) pointers a persistent faint pencil.
  const trigger = (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      className={cn(
        "relative block max-w-full rounded-md text-left outline-none",
        // Reserve room for the pencil: always without a tooltip, otherwise only on touch.
        tooltip ? "pointer-coarse:pr-5" : "pr-5",
      )}
    >
      <span className={cn("block truncate", displayClassName)}>{value || placeholder}</span>
      {/* The pencil sits inside the button (right-0) so it doesn't overlap a following badge. */}
      <Pencil
        className={cn(
          "-translate-y-1/2 pointer-events-none absolute top-1/2 right-0 text-muted-foreground",
          tooltip ? "opacity-0 pointer-coarse:opacity-50" : "opacity-50",
        )}
        aria-hidden
      />
    </button>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {/* The tooltip is clipped inside overflow-hidden containers, so the parent can disable it. */}
      {tooltip ? (
        <Tooltip content={tc("clickToEdit")} side="top">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      {children}
    </div>
  );
}
