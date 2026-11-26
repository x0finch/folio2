import { cn, LogoAvatar } from "@folio/ui";

// Target label of a custom tab: tag `#name`, account `@name`, connector `logo + type name`, shared
// by the pin pill and the picker so both match. `#`/`@` are display-only prefixes.
// Pure display: name and logo are already resolved, so the home strip makes no catalog request.
// The connector logo uses LogoAvatar (initials fallback), sized the size below to match the `#`/`@` glyph height.
// onPrimary: an active pill has a light bg-primary fill and some logos are light themselves (OKX
// white, manual transparent), so a hairline border separates them; recoloring the logo backing
// can't fix a color baked into the image.
function ConnectorMark({
  logo,
  fallback,
  onPrimary,
}: {
  logo?: string;
  fallback: string;
  onPrimary?: boolean;
}) {
  return (
    <LogoAvatar
      src={logo}
      fallback={fallback}
      size="sm"
      className={cn("mr-1 size-3.5", onPrimary && "ring-1 ring-primary-foreground/40")}
    />
  );
}

export function PinTargetMark({
  kind,
  name,
  logo,
  onPrimary,
  className,
}: {
  kind: "connector" | "tag" | "account";
  name: string;
  logo?: string;
  onPrimary?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      {/* aria-hidden: the mark is decorative; otherwise the Avatar's initial leaks into the accessible name ("MManual"). */}
      {kind === "connector" && (
        <span aria-hidden className="flex">
          <ConnectorMark logo={logo} fallback={name} onPrimary={onPrimary} />
        </span>
      )}
      {/* `#`/`@` hug the name (like TagBadges); only the logo gets a gap. */}
      <span className="min-w-0 truncate">
        {kind === "tag" ? "#" : kind === "account" ? "@" : ""}
        {name}
      </span>
    </span>
  );
}
