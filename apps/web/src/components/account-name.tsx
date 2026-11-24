import { cn } from "@folio/ui";

// `@` is a display-only prefix (never stored), like `#` for tags.
export function AccountName({ name, className }: { name: string; className?: string }) {
  return (
    // select-text: the name is content and must stay copyable inside non-selectable rows/cards.
    <span className={cn("flex min-w-0 select-text items-center", className)}>
      <span className="truncate">@{name}</span>
    </span>
  );
}
