import { Cause, type Effect, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { type HistoryRange, rangeSince } from "@/lib/core/history";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleListAccounts } from "@/lib/server/accounts/list";
import type { AppError } from "@/lib/server/errors";
import { handleGetTokenValueHistory } from "@/lib/server/holdings/history";
import { createManualAccount } from "@/lib/server/manual/store";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { NAMER } from "@/lib/server/oracle";
import { handleGetFiatRefs } from "@/lib/server/portfolio/fiat-refs";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { handleResolvePlatformMeta } from "@/lib/server/portfolio/platform-meta";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import type { UserServices } from "@/lib/server/runtime";
import { handleGetDataStats } from "@/lib/server/settings/data-stats";
import { handleGetDataVersion } from "@/lib/server/settings/data-version";
import { handleGetProviderKeyStatus } from "@/lib/server/settings/provider-keys";
import { handleGetValuationSettings } from "@/lib/server/settings/valuation";
import { handleGetSyncRound } from "@/lib/server/sync/round";
import { handleGetPortfolioTabPins } from "@/lib/server/tab-pins/read";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { handleListTokenCatalogue } from "@/lib/server/tokens/catalogue";
import { handleGetTokenEnrichment } from "@/lib/server/tokens/enrichment";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { db } from "./_kit/db";
import { blockOutbound, type Outbound } from "./_kit/outbound";
import { call, callExit } from "./_kit/run";
import { DAY, HOUR, seedAccount, seedSnapshot } from "./_kit/seed";
import { freshUser } from "./_kit/user";
import { ticketOf } from "./ticket";

// Read endpoints never go outbound: every GET server fn runs under a fetch that throws on any call and
// must make none (free plan: 10ms CPU per request; reads use local caches that cron and sync warm).
// The set of GET server fns is counted from source (`GET_SERVER_FNS`): adding one without registering it fails the first case.
// Exceptions are only interactive reads (`ALLOWED`) and cold-cache fills (`COLD_CACHE_FILL`, pinned in reverse: they must still go outbound).

const GET_SERVER_FNS = (() => {
  const sources = import.meta.glob("../../src/lib/server/**/index.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const names = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/export const (\w+) = createServerFn\(\{ method: "GET" \}\)/g)) {
      names.add(m[1]);
    }
  }
  return names;
})();

/** Inherently interactive reads: no local answer exists or should. */
const ALLOWED: Record<string, string> = {
  listTokens:
    "token picker search: searches the upstream for what the user typed; results are never local.",
  getTokenPrice:
    "'fill in market price' when entering a manual holding: the user wants an upstream price right then.",
};

/**
 * Cold-cache fill once: on a miss the read fetches upstream once and writes the cache. `listTokenCatalogue` stays
 * deliberately: it is the token picker's only default list and its `catalogue` job runs daily, so a new user would
 * otherwise see an empty default list before the first cron. It runs only when the user opens the dropdown.
 */
const COLD_CACHE_FILL: Record<string, string> = {
  listTokenCatalogue:
    "token catalogue (top N by market cap): fetches CoinGecko /coins/markets once when both the catalogue cache and the edge cache are cold.",
};

/** Cannot run here (no Effect runtime, no upstream to reach); reasons are explicit, not missing coverage. */
const NOT_RUN_HERE: Record<string, string> = {
  getSession:
    "better-auth reads the session (cookie + D1) and needs a real request's headers; no outbound path. Covered by the require-auth cases.",
  listConnectors: "inline in connectors/index.ts, reads only the static ConnectorRegistry.catalog.",
  getConnectorCredentialSpecs:
    "inline in connectors/index.ts, reads only the static ConnectorRegistry.specs.",
};

type Run = () => Effect.Effect<unknown, AppError, UserServices>;

/**
 * One case = one call plus assertions that it succeeded and took the intended branch. Counting outbound alone
 * would pass a handler that fails up front (bad args, ownership rejection, missing fixture), so each case must
 * succeed and `check` must confirm it got data (e.g. the long window took the `sampled` branch) before outbound is read.
 */
interface Case {
  name: string;
  fn: string;
  run: Run;
  check?: (value: unknown) => void;
}

interface Fixture {
  portfolioId: string;
  syncedId: string;
  manualId?: string;
}

const NOW = floorToHour(Date.now());
const BTC = "token-btc";

/** History inputs: has data and takes the expected tier (long window = `sampled`). */
const historyCheck =
  (sampled: boolean) =>
  (value: unknown): void => {
    const raw = value as { rows: unknown[]; sampled?: boolean };
    expect(raw.rows.length).toBeGreaterThan(0);
    expect(raw.sampled ?? false).toBe(sampled);
  };

const portfolioHistoryCase = (range: HistoryRange): Case => ({
  name: `getPortfolioHistory(${range})`,
  fn: "getPortfolioHistory",
  run: () => handleGetPortfolioHistory({ range }),
  check: historyCheck(range === "1y" || range === "all"),
});

const accountHistoryCase = (
  label: string,
  accountId: string,
  connectorId: string,
  range: HistoryRange,
): Case => ({
  name: `getAccountHistory(${label}, ${range})`,
  fn: "getAccountHistory",
  run: () =>
    handleGetAccountHistory({ accountId, connectorId, range, since: rangeSince(range, NOW) }),
  check: historyCheck(range === "1y" || range === "all"),
});

const RANGES: HistoryRange[] = ["7d", "30d", "1y", "all"];

/** A group (or several) of representative calls per GET server fn. Key = case name, `fn` = the server fn name in source. */
const cases = (f: Fixture): Case[] => [
  { name: "listPortfolios", fn: "listPortfolios", run: () => handleListPortfolios() },
  { name: "getSnapshots(now)", fn: "getSnapshots", run: () => handleGetSnapshots({ at: NOW }) },
  {
    name: "getSnapshots(prev)",
    fn: "getSnapshots",
    run: () => handleGetSnapshots({ at: NOW - GAIN_WINDOW_MS, after: NOW - GAIN_START_FLOOR_MS }),
  },
  { name: "getFiatRefs", fn: "getFiatRefs", run: () => handleGetFiatRefs({}) },
  {
    name: "resolvePlatformMeta",
    fn: "resolvePlatformMeta",
    run: () => handleResolvePlatformMeta({ chainIds: ["bitcoin", "ethereum"] }),
  },
  ...RANGES.map(portfolioHistoryCase),
  { name: "getDataStats", fn: "getDataStats", run: () => handleGetDataStats() },
  { name: "getDataVersion", fn: "getDataVersion", run: () => handleGetDataVersion() },
  {
    name: "getValuationSettings",
    fn: "getValuationSettings",
    run: () => handleGetValuationSettings(),
  },
  {
    name: "getTokenValueHistory(30d)",
    fn: "getTokenValueHistory",
    run: () => handleGetTokenValueHistory({ key: BTC, range: "30d", since: NOW - 30 * DAY }),
    check: historyCheck(false),
  },
  {
    name: "getTokenValueHistory(all)",
    fn: "getTokenValueHistory",
    run: () => handleGetTokenValueHistory({ key: BTC, range: "all" }),
    check: historyCheck(true),
  },
  {
    name: "getPortfolioTabPins",
    fn: "getPortfolioTabPins",
    run: () => handleGetPortfolioTabPins(),
  },
  {
    name: "getCurrencyPreference",
    fn: "getCurrencyPreference",
    run: () => handleGetCurrencyPreference({ code: "EUR" }),
  },
  {
    name: "getSyncRound",
    fn: "getSyncRound",
    run: () => handleGetSyncRound({ portfolioId: f.portfolioId }),
  },
  { name: "listTokenCatalogue", fn: "listTokenCatalogue", run: () => handleListTokenCatalogue() },
  { name: "getTokenEnrichment", fn: "getTokenEnrichment", run: () => handleGetTokenEnrichment() },
  {
    name: "listFiatOptions",
    fn: "listFiatOptions",
    run: () => handleListFiatOptions({ locale: "en" }),
  },
  { name: "listAccounts", fn: "listAccounts", run: () => handleListAccounts({}) },
  ...RANGES.map((range) => accountHistoryCase("synced", f.syncedId, "bitcoin", range)),
  // Manual-account cases run only when a manual account exists: with a synced account's id, the ownership/lookup
  // step would reject and the code that might go outbound would never run.
  ...(f.manualId
    ? [
        {
          name: "getManualAccount",
          fn: "getManualAccount",
          run: () => handleGetManualAccount({ accountId: f.manualId as string }),
          check: (value: unknown) => {
            expect((value as { tokens: unknown[] }).tokens.length).toBeGreaterThan(0);
          },
        },
        ...RANGES.map((range) =>
          accountHistoryCase("manual", f.manualId as string, "manual", range),
        ),
      ]
    : []),
  { name: "listTags", fn: "listTags", run: () => handleListTags({}) },
  { name: "listAccountTags", fn: "listAccountTags", run: () => handleListAccountTags({}) },
];

// getProviderKeyStatus reads only env (not Effect): called directly, also under the offline fetch.
const plainCases: { name: string; fn: string; run: () => unknown }[] = [
  { name: "getProviderKeyStatus", fn: "getProviderKeyStatus", run: handleGetProviderKeyStatus },
];

const USER = "h-no-egress";

/**
 * Runs each case, recording the URLs it hit and the cases that did not succeed or take the intended branch (`failed`).
 * Cold-cache cases fail under the offline fetch by design (they need outbound to fill) and don't count.
 */
const egressByCase = async (
  outbound: Outbound,
  f: Fixture,
): Promise<{ egress: Map<string, string[]>; failed: string[] }> => {
  const egress = new Map<string, string[]>();
  const failed: string[] = [];
  for (const c of cases(f)) {
    const before = outbound.calls.length;
    const exit = await callExit(USER, c.run());
    egress.set(c.name, outbound.calls.slice(before));
    if (c.fn in COLD_CACHE_FILL) continue;
    if (Exit.isFailure(exit)) {
      failed.push(`${c.name}: ${Cause.pretty(exit.cause).split("\n")[0]}`);
      continue;
    }
    try {
      c.check?.(exit.value);
    } catch (e) {
      failed.push(`${c.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  for (const c of plainCases) {
    const before = outbound.calls.length;
    c.run();
    egress.set(c.name, outbound.calls.slice(before));
  }
  return { egress, failed };
};

const seedSynced = async (): Promise<Fixture> => {
  const acc = await seedAccount(USER, "Cold wallet", "bitcoin");
  // Two months daily + the latest day hourly: short window, daily rollup and long window all have data.
  for (let d = 60; d >= 1; d--) {
    await seedSnapshot(USER, acc.id, NOW - d * DAY, [
      { tokenId: BTC, amount: 1, usdValue: 100 + d, platform: "bitcoin" },
    ]);
  }
  for (let h = 23; h >= 0; h--) {
    await seedSnapshot(USER, acc.id, NOW - h * HOUR, [
      { tokenId: BTC, amount: 1, usdValue: 200 + h, platform: "bitcoin" },
    ]);
  }
  const pf = await db(USER).portfolios.ensureDefault();
  return { portfolioId: pf.id, syncedId: acc.id };
};

describe("GET server fns make no outbound calls", () => {
  let outbound: Outbound;
  beforeEach(async () => {
    outbound = blockOutbound();
    await freshUser(USER);
  });

  it("every GET server fn is registered here (counted from source)", () => {
    const covered = new Set([
      ...cases({ portfolioId: "p", syncedId: "a", manualId: "m" }).map((c) => c.fn),
      ...plainCases.map((c) => c.fn),
      ...Object.keys(ALLOWED),
      ...Object.keys(NOT_RUN_HERE),
    ]);
    // Cold-cache entries must actually run above (exempt from outbound, not from testing).
    expect(Object.keys(COLD_CACHE_FILL).filter((n) => !covered.has(n))).toEqual([]);
    expect(GET_SERVER_FNS.size).toBeGreaterThan(20);
    expect([...GET_SERVER_FNS].filter((n) => !covered.has(n)).sort()).toEqual([]);
    // A stale name in the exception tables is a hole left behind after a rename or removal.
    const stale = [...Object.keys(ALLOWED), ...Object.keys(NOT_RUN_HERE)].filter(
      (n) => !GET_SERVER_FNS.has(n),
    );
    expect(stale).toEqual([]);
  });

  it("synced accounts only: not a single call", async () => {
    const f = await seedSynced();
    const { egress, failed } = await egressByCase(outbound, f);
    expect(failed).toEqual([]);
    const offenders = [...egress].filter(
      ([name, urls]) => urls.length > 0 && !(name in COLD_CACHE_FILL),
    );
    expect(offenders).toEqual([]);
    // Pinned in reverse: every cold-cache exemption must still go outbound; once one becomes cache-only, delete
    // its exemption here instead of leaving a forgotten hole.
    const stillFetching = Object.keys(COLD_CACHE_FILL).filter(
      (n) => (egress.get(n)?.length ?? 0) > 0,
    );
    expect(stillFetching.sort()).toEqual(Object.keys(COLD_CACHE_FILL).sort());
  }, 120_000);

  // Manual accounts: the 24h-ago end, portfolio curves 7d/30d/1y and the manual drawer curve are computed from the ledger x
  // the table's daily prices; gaps stay gaps (the queue's `daily-prices` job fills them), reads never go outbound.
  it("adding a manual account: still not a single call (historical daily prices are table-only)", async () => {
    const f = await seedSynced();
    // Manual holding with a picked coin (CoinGecko identity): the only kind that has upstream historical prices to fetch.
    const manual = await call(
      USER,
      createManualAccount(
        "Manual",
        JSON.stringify([
          { symbol: "BTC", unitPrice: 50_000, amount: 0.1, ticket: ticketOf("bitcoin") },
        ]),
      ),
    );
    // Add an opening entry 40 days ago so the "24h ago" end and the curves must really recompute from the ledger.
    const [holding] = await db(USER).manual.listHoldings(manual.id, NAMER);
    await db(USER).manual.recordActivity(manual.id, holding.id, {
      kind: "set",
      amount: 600,
      price: 1,
      occurredAt: NOW - 40 * DAY,
    });
    outbound.calls.length = 0;
    const { egress, failed } = await egressByCase(outbound, { ...f, manualId: manual.id });
    expect(failed).toEqual([]);
    const offenders = [...egress].filter(
      ([name, urls]) => urls.length > 0 && !(name in COLD_CACHE_FILL),
    );
    expect(offenders).toEqual([]);
    // Manual cases did run and succeeded (`failed` is empty above); without a manual account they don't run, so zero outbound proves nothing.
    for (const range of RANGES)
      expect(egress.has(`getAccountHistory(manual, ${range})`)).toBe(true);
    expect(egress.has("getManualAccount")).toBe(true);
  }, 120_000);
});
