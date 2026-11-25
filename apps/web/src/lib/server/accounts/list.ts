import { Database } from "@folio/db";
import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { missingCreds, publicValues, readStoredCreds, safeView } from "@/lib/server/creds";
import { type PortfolioScope, scopedMembership } from "@/lib/server/portfolio/scope";
import { serverFn } from "@/lib/server/server-fn";

// Raw creds (incl. secret ciphertext) never leave the server, only the safeView projection.
export const handleListAccounts = serverFn("listAccounts")(function* (data: PortfolioScope = {}) {
  const { accounts: store } = yield* Database;
  const connectors = yield* ConnectorRegistry;
  const specsByType = connectors.specs;
  const [scope, rawList] = yield* Effect.all(
    [scopedMembership(data.portfolioId), store.listRawCreds()],
    { concurrency: 2 },
  );
  const accounts = scope.accounts.filter((a) => scope.has(a.id));
  const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
  // Unparseable creds list as incomplete with one warning: this page is where they get re-entered.
  const unreadable: string[] = [];
  const rows = accounts.map((a) => {
    const parsed = readStoredCreds(rawById.get(a.id));
    if (parsed === null) unreadable.push(a.id);
    const stored = parsed ?? {};
    const specs = specsByType[a.connectorId] ?? [];
    const missing = missingCreds(
      specs,
      stored,
      connectors.neededCreds(a.connectorId, publicValues(specs, stored)),
    );
    return {
      ...a,
      portfolioId: scope.portfolioIdOf(a.id),
      needsCredentials: missing.length > 0,
      missingCreds: missing,
      credsSafe: safeView(specs, stored),
    };
  });
  if (unreadable.length > 0) {
    yield* Effect.logWarning("stored creds unreadable, listed as incomplete").pipe(
      Effect.annotateLogs({ accountIds: unreadable }),
    );
  }
  return rows;
});
