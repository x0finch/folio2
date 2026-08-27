import { Effect } from "effect";
import { defiGainKey } from "@/lib/core/account-view";
import { loadAccountHoldings } from "./account-holdings";
import { buildScopedOverview, type PortfolioScope } from "./scope";

// #488 票 5:24h 盈亏独立读取。同一条 `buildScopedOverview(..., true)`,只把盈亏字段带出来。
export const handleGetPortfolioGain24h = Effect.fn("getPortfolioGain24h")(function* (
  data: PortfolioScope,
) {
  const view = yield* buildScopedOverview(data, true);
  const holdings: Record<string, (typeof view.holdings)[number]["gain24h"]> = {};
  for (const h of view.holdings) holdings[h.key] = h.gain24h ?? null;
  const defi: Record<
    string,
    NonNullable<(typeof view.sections)[number]["defi"][number]["gain24h"]> | null
  > = {};
  for (const s of view.sections) {
    for (const g of s.defi) {
      defi[defiGainKey(s.account.id, g.protocol)] = g.gain24h ?? null;
    }
  }
  return { portfolio: view.gain24h ?? null, holdings, defi };
});

// #493 票 3:账户页 24h 盈亏独立读取。同一条 `loadAccountHoldings(scope, true)`,只把盈亏字段带出来。
export const handleGetAccountGain24h = Effect.fn("getAccountGain24h")(function* (
  data: PortfolioScope = {},
) {
  const view = yield* loadAccountHoldings(data, true);
  const accounts: Record<string, NonNullable<(typeof view.rows)[number]["gain24h"]> | null> = {};
  const balances: Record<
    string,
    NonNullable<(typeof view.rows)[number]["balances"][number]["gain24h"]> | null
  > = {};
  for (const r of view.rows) {
    if (r.archivedAt == null) accounts[r.account.id] = r.gain24h ?? null;
    for (const b of r.balances) {
      if (r.archivedAt != null || b.tokenId == null) continue;
      balances[b.id] = b.gain24h ?? null;
    }
  }
  return { accounts, balances };
});
