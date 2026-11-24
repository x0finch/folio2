import { type AccountSafe, Database, type DbRequest, type PortfolioMembership } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { inView, type TabPinScope } from "@/lib/core/accounts-in-view";

// `portfolioId` is optional (falls back to the default); `{}` default lets loaders call it without args.
export const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// Adds a custom-tab pin on top of the selected portfolio; narrows the overview list only, not the curve.
// The pin's TS shape lives in core/accounts-in-view (`TabPinScope`).
export const PortfolioScopeInput = z
  .object({
    portfolioId: z.string().optional(),
    pin: z
      .object({
        kind: z.enum(["connector", "tag", "account"]),
        connectorId: z.string().optional(),
        tagId: z.string().optional(),
        accountId: z.string().optional(),
      })
      .optional(),
  })
  .default({});

export interface PortfolioScope {
  portfolioId?: string;
  pin?: NonNullable<TabPinScope>;
}

// A requested id that isn't the user's falls back to the default (empty view otherwise, no leak).
// One query: ensureDefault runs only when the default row isn't listed (new user).
export const resolveScope = (
  requested: string | undefined,
): Effect.Effect<{ selectedId: string; defaultId: string }, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).portfolios;
    const portfolios = yield* store.list();
    const defaultId = portfolios.find((p) => p.isDefault)?.id ?? (yield* store.ensureDefault()).id;
    const selectedId =
      requested && portfolios.some((p) => p.id === requested) ? requested : defaultId;
    return { selectedId, defaultId };
  });

// Membership test for the current portfolio, shared by account-domain reads. Ignores archiving
// (the accounts page shows archived); `accountsInView` excludes it for totals. Pick by "does this page show archived?".
export interface ScopedMembership {
  selectedId: string;
  defaultId: string;
  /** All the user's accounts (not filtered by portfolio; use `has`), from one join with membership. */
  accounts: AccountSafe[];
  /** Account -> portfolio rows, the raw input of the `accountsInView` family. */
  memberships: PortfolioMembership[];
  /** Whether the account is in the current portfolio's view, archived or not. */
  has: (accountId: string) => boolean;
  /** Owning portfolio; accounts with no membership row count as the default. */
  portfolioIdOf: (accountId: string) => string;
}

export const scopedMembership = (
  requested: string | undefined,
): Effect.Effect<ScopedMembership, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [{ selectedId, defaultId }, rows] = yield* Effect.all(
      [resolveScope(requested), db.accounts.listWithPortfolio()],
      { concurrency: 2 },
    );
    const portfolioOf = new Map<string, string>();
    const memberships: PortfolioMembership[] = [];
    const accounts: AccountSafe[] = [];
    for (const { portfolioId, ...account } of rows) {
      accounts.push(account);
      if (portfolioId != null) {
        portfolioOf.set(account.id, portfolioId);
        memberships.push({ accountId: account.id, portfolioId });
      }
    }
    return {
      selectedId,
      defaultId,
      accounts,
      memberships,
      has: (accountId) => inView(portfolioOf.get(accountId), selectedId, defaultId),
      portfolioIdOf: (accountId) => portfolioOf.get(accountId) ?? defaultId,
    };
  });
