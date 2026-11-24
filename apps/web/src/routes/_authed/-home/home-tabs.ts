import type { PinScopeKey } from "@/lib/queries/keys";

// Pure file without route API imports: `pickShownTab` is unit-tested and `tab/selection.ts` pulls
// in `getRouteApi`, which breaks the logic test environment. Presence/pin-label logic lives in `lib/core/portfolio`.

// All perspective tab names, not just the present ones; custom pin ids are runtime data and not listed.
export const KIND_TABS = ["tokens", "perps", "defi"] as const;
export type KindTab = (typeof KIND_TABS)[number];

// Default tab: omitted from the URL (stripped by `stripSearchParams`).
export const DEFAULT_TAB: KindTab = "tokens";

// Which tab to show. A pin not yet in the data (`requested` unknown, `lastKnown` known) keeps the
// last known tab so the pill doesn't flash back; a deleted pin id falls back to the default. Can't
// live in `validateSearch`: valid values include runtime pin ids.
export function pickShownTab(
  requested: string,
  lastKnown: string,
  isKnown: (v: string) => boolean,
): string {
  if (isKnown(requested)) return requested;
  if (isKnown(lastKnown)) return lastKnown;
  return DEFAULT_TAB;
}

// Tokens always; perps / DeFi only when present (from the light request's booleans, so tabs never appear late).
export function kindTabsOf(hasPerps: boolean, hasDefi: boolean): KindTab[] {
  const tabs: KindTab[] = ["tokens"];
  if (hasPerps) tabs.push("perps");
  if (hasDefi) tabs.push("defi");
  return tabs;
}

// Where the pill lands after unpinning: the left neighbour pin, else the last perspective tab.
export function tabAfterUnpin(
  pinId: string,
  pins: readonly { id: string }[],
  kindTabs: readonly KindTab[],
): string {
  const idx = pins.findIndex((p) => p.id === pinId);
  return idx > 0 ? pins[idx - 1].id : kindTabs[kindTabs.length - 1];
}

export function pinScopeOf(pin: {
  kind: "connector" | "tag" | "account";
  connectorId?: string | null;
  tagId?: string | null;
  accountId?: string | null;
}): PinScopeKey {
  if (pin.kind === "tag") return { kind: "tag", tagId: pin.tagId ?? undefined };
  if (pin.kind === "account") return { kind: "account", accountId: pin.accountId ?? undefined };
  return { kind: "connector", connectorId: pin.connectorId ?? undefined };
}
