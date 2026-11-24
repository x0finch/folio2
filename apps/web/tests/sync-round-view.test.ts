import type { SyncRoundAccount, SyncRoundRecord } from "@folio/db";
import { describe, expect, it } from "vitest";
import { syncRoundView } from "@/lib/server/sync/status";

//

const NOW = 1_700_000_000_000;

const account = (label: string, over: Partial<SyncRoundAccount> = {}): SyncRoundAccount => ({
  label,
  status: "pending",
  ...over,
});

const record = (over: Partial<SyncRoundRecord> = {}): SyncRoundRecord => ({
  roundId: "r1",
  portfolioId: "pf-1",
  trigger: "manual",
  startedAt: NOW - 5_000,
  finishedAt: null,
  accounts: {
    "acc-1": account("Binance"),
    "acc-2": account("Kraken"),
    "acc-3": account("Bybit"),
  },
  expiresAt: NOW + 120_000,
  ...over,
});

describe("round status", () => {
  it("not finalized, heartbeat alive: running", () => {
    expect(syncRoundView(record(), NOW).state).toBe("running");
  });

  it("finalized: finished (even long past the retention period)", () => {
    const view = syncRoundView(record({ finishedAt: NOW - 1_000, expiresAt: NOW - 500 }), NOW);
    expect(view.state).toBe("done");
  });

  it("not finalized and heartbeat lost: interrupted", () => {
    expect(syncRoundView(record({ expiresAt: NOW - 1 }), NOW).state).toBe("interrupted");
  });

  it("counts as lost at the expiry instant (`<=`, same rule as the round-opening coverage check)", () => {
    expect(syncRoundView(record({ expiresAt: NOW }), NOW).state).toBe("interrupted");
  });
});

describe("three-segment counts", () => {
  it("the three segments are independent: failed is not synced, missing credentials is not failed", () => {
    const view = syncRoundView(
      record({
        finishedAt: NOW,
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "failed", error: "401 from upstream" }),
          "acc-3": account("Bybit", { status: "needs-keys" }),
        },
      }),
      NOW,
    );
    expect(view.synced).toBe(1);
    expect(view.needsKeys).toBe(1);
    expect(view.failed).toEqual([
      { accountId: "acc-2", label: "Kraken", error: "401 from upstream" },
    ]);
  });

  it("skipped is its own segment, counts into settled, not mixed into synced/failed", () => {
    const view = syncRoundView(
      record({
        finishedAt: NOW,
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "skipped" }),
          "acc-3": account("Bybit", { status: "skipped" }),
        },
      }),
      NOW,
    );
    expect(view.synced).toBe(1);
    expect(view.skipped).toBe(2);
    expect(view.failed).toEqual([]);
    expect(view.settled).toBe(3);
    expect(view.total).toBe(3);
  });

  it("a failure without a message still has a displayable line: the panel never shows a blank row", () => {
    const view = syncRoundView(
      record({ accounts: { "acc-1": account("Binance", { status: "failed" }) } }),
      NOW,
    );
    expect(view.failed[0]?.error).toBeTruthy();
  });

  it('`x / N` counts "with a result / total"; accounts not yet reached do not count', () => {
    const view = syncRoundView(
      record({
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "failed", error: "boom" }),
          "acc-3": account("Bybit"),
        },
      }),
      NOW,
    );
    expect(view.settled).toBe(2);
    expect(view.total).toBe(3);
  });

  it("the whole-round failure message is carried verbatim", () => {
    const view = syncRoundView(record({ finishedAt: NOW, error: "account store exploded" }), NOW);
    expect(view.error).toBe("account store exploded");
    expect(view.failed).toEqual([]);
  });

  it("no whole-round failure: error is null, not undefined", () => {
    expect(syncRoundView(record(), NOW).error).toBeNull();
  });
});

describe("who is syncing", () => {
  it("first one not yet reached: this is what polling sees", () => {
    const view = syncRoundView(
      record({
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken"),
          "acc-3": account("Bybit"),
        },
      }),
      NOW,
    );
    expect(view.current).toBe("Kraken");
  });

  it("all have results: nobody is syncing", () => {
    const view = syncRoundView(
      record({ accounts: { "acc-1": account("Binance", { status: "synced" }) } }),
      NOW,
    );
    expect(view.current).toBeNull();
  });

  it("finalized round: still-pending accounts leave the denominator and go into unresolved", () => {
    const view = syncRoundView(
      record({
        finishedAt: NOW,
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "synced" }),
          "acc-3": account("已归档的"),
        },
      }),
      NOW,
    );
    expect(view.total).toBe(2);
    expect(view.settled).toBe(2);
    expect(view.synced).toBe(2);
    expect(view.unresolved).toBe(1);
  });

  it("running round: pending means not yet reached, stays in the denominator, unresolved is 0", () => {
    const view = syncRoundView(
      record({
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken"),
        },
      }),
      NOW,
    );
    expect(view.total).toBe(2);
    expect(view.unresolved).toBe(0);
  });

  it("round with no accounts: denominator 0, no crash", () => {
    const view = syncRoundView(record({ accounts: {}, finishedAt: NOW }), NOW);
    expect(view.total).toBe(0);
    expect(view.settled).toBe(0);
    expect(view.current).toBeNull();
  });
});
