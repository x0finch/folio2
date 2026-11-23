import type { AccountTagLink, PortfolioMembership } from "@folio/db";

// Single source of truth for which accounts a view aggregates, so every number agrees.
// An account with no membership row falls into the default portfolio: better shown twice than
// silently missing from net worth.
export function inView(
  membershipPortfolioId: string | undefined,
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): boolean {
  if (membershipPortfolioId === selectedPortfolioId) return true;
  if (membershipPortfolioId === undefined && selectedPortfolioId === defaultPortfolioId)
    return true;
  return false;
}

export function accountsInView<A extends { id: string; archivedAt: number | null }>(
  accounts: A[],
  memberships: PortfolioMembership[],
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): A[] {
  const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
  return accounts.filter(
    (a) =>
      a.archivedAt == null &&
      inView(portfolioOf.get(a.id), selectedPortfolioId, defaultPortfolioId),
  );
}

// null = default view (no narrowing).
export type TabPin =
  | { kind: "connector"; connectorId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "account"; accountId: string };

// Loose client-side shape; a missing id means no pin.
export type TabPinScope =
  | {
      kind: "connector" | "tag" | "account";
      connectorId?: string;
      tagId?: string;
      accountId?: string;
    }
  | null
  | undefined;

export function toTabPin(scope: TabPinScope): TabPin | null {
  if (!scope) return null;
  if (scope.kind === "connector" && scope.connectorId) {
    return { kind: "connector", connectorId: scope.connectorId };
  }
  if (scope.kind === "tag" && scope.tagId) return { kind: "tag", tagId: scope.tagId };
  if (scope.kind === "account" && scope.accountId) {
    return { kind: "account", accountId: scope.accountId };
  }
  return null;
}

// Narrows an already portfolio-filtered set; a pin never reaches outside its portfolio.
export function accountsMatchingPin<A extends { id: string; connectorId: string }>(
  accounts: A[],
  pin: TabPin | null,
  tagLinks: AccountTagLink[],
): A[] {
  if (!pin) return accounts;
  if (pin.kind === "connector") {
    return accounts.filter((a) => a.connectorId === pin.connectorId);
  }
  if (pin.kind === "account") {
    return accounts.filter((a) => a.id === pin.accountId);
  }
  const tagged = new Set(tagLinks.filter((l) => l.tagId === pin.tagId).map((l) => l.accountId));
  return accounts.filter((a) => tagged.has(a.id));
}

// Ignores archiving: past chart points still count archived members, and moving an account
// between portfolios recomputes the whole curve.
export function accountIdsInView(
  accountIds: string[],
  memberships: readonly PortfolioMembership[],
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): Set<string> {
  const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
  return new Set(
    accountIds.filter((id) => inView(portfolioOf.get(id), selectedPortfolioId, defaultPortfolioId)),
  );
}

// Per portfolio, not per user: otherwise a full default portfolio blocks pinning elsewhere.
// Shared by client (hide +) and server (reject the 4th).
export const MAX_PINS_PER_PORTFOLIO = 3;

// Nullable because `tab_pins` fills only the column for its kind.
export interface PinTargetRef {
  kind: "connector" | "tag" | "account";
  connectorId?: string | null;
  tagId?: string | null;
  accountId?: string | null;
}

// A pin's portfolio is derived from its target (tab_pins has no portfolio_id), so a connector pin
// can appear in, and count against, several portfolios. Display and the cap share this function so
// they never disagree.
export function pinsInView<P extends PinTargetRef>(
  pins: readonly P[],
  view: {
    /** Active accounts in the view (output of `accountsInView`). */
    accounts: readonly { id: string; connectorId: string }[];
    tagIds: ReadonlySet<string>;
  },
): P[] {
  const accountIds = new Set(view.accounts.map((a) => a.id));
  const connectorIds = new Set(view.accounts.map((a) => a.connectorId));
  return pins.filter((p) => {
    if (p.kind === "tag") return p.tagId != null && view.tagIds.has(p.tagId);
    if (p.kind === "account") return p.accountId != null && accountIds.has(p.accountId);
    return p.connectorId != null && connectorIds.has(p.connectorId);
  });
}
