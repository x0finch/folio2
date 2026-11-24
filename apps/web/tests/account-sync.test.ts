import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoundView } from "@/lib/server/sync/status";

// syncAccount only enqueues and returns; the outcome is read from the sync round.
const { syncAccount, getSyncRound } = vi.hoisted(() => ({
  syncAccount: vi.fn(),
  getSyncRound: vi.fn(),
}));
vi.mock("@/lib/server/sync", () => ({ syncAccount, getSyncRound }));

const { ACCOUNT_SYNC_TIMEOUT_MS, accountOutcomeIn, syncAccountAndWait } = await import(
  "@/lib/queries/account-sync"
);
const { JOB_MAX_RETRIES, jobRetryDelayMs, SYNC_RETRY_CHAIN_MS } = await import(
  "@/lib/server/jobs/constants"
);
const { syncKeys } = await import("@/lib/queries/keys");

const ACC = "acc-1";

const view = (over: Partial<SyncRoundView> = {}): SyncRoundView => ({
  roundId: "r1",
  state: "running",
  trigger: "manual",
  startedAt: 0,
  finishedAt: null,
  total: 1,
  settled: 0,
  synced: 0,
  failed: [],
  needsKeys: 0,
  skipped: 0,
  current: "Binance",
  unresolved: 0,
  error: null,
  statuses: { [ACC]: "pending" },
  ...over,
});

describe("accountOutcomeIn", () => {
  it("still pending while the round runs → null (keep waiting)", () => {
    expect(accountOutcomeIn(view(), "r1", ACC)).toBeNull();
  });

  it("each of the four settled states maps to its outcome shape", () => {
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "synced" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: true,
    });
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "needs-keys" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "skipped" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
    });
    expect(
      accountOutcomeIn(
        view({
          statuses: { [ACC]: "failed" },
          failed: [{ accountId: ACC, label: "Binance", error: "binance 429" }],
        }),
        "r1",
        ACC,
      ),
    ).toEqual({ accountId: ACC, ok: false, error: "binance 429" });
  });

  it("round aborted before reaching it → failure (no upstream message)", () => {
    expect(accountOutcomeIn(view({ state: "interrupted" }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
    });
  });

  it("round superseded / unreadable → silently skipped", () => {
    const skipped = { accountId: ACC, ok: false, skipped: true };
    expect(accountOutcomeIn(view({ roundId: "r2" }), "r1", ACC)).toEqual(skipped);
    expect(accountOutcomeIn(null, "r1", ACC)).toEqual(skipped);
  });

  it("round finished while it is still pending (archived mid-round) → skipped", () => {
    expect(accountOutcomeIn(view({ state: "done", finishedAt: 1 }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
    });
  });
});

describe("syncAccountAndWait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("immediate result (manual / missing creds) → returned as-is, no polling", async () => {
    const result = { accountId: ACC, ok: false, skipped: true, skipReason: "manual" };
    syncAccount.mockResolvedValue({ queued: false, result });
    const client = new QueryClient();

    await expect(syncAccountAndWait(client, ACC)).resolves.toEqual(result);
    expect(getSyncRound).not.toHaveBeenCalled();
  });

  it("queued in a round → seeds the cache, then polls the round until it settles", async () => {
    const start = view();
    syncAccount.mockResolvedValue({
      queued: true,
      accountId: ACC,
      portfolioId: "pf-1",
      roundId: "r1",
      round: start,
    });
    getSyncRound.mockResolvedValueOnce(view({ settled: 0 })).mockResolvedValueOnce(
      view({
        state: "done",
        finishedAt: 1,
        settled: 1,
        synced: 1,
        statuses: { [ACC]: "synced" },
      }),
    );
    const client = new QueryClient();
    const seen: unknown[] = [];
    client.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action.type === "success") seen.push(e.query.state.data);
    });

    const outcome = await syncAccountAndWait(client, ACC, { pollMs: 1 });

    expect(outcome).toEqual({ accountId: ACC, ok: true });
    expect(seen[0]).toEqual(start); // the header pill can render immediately
    expect(getSyncRound).toHaveBeenCalledTimes(2);
    expect(getSyncRound).toHaveBeenCalledWith({ data: { portfolioId: "pf-1" } });
    expect(client.getQueryData(syncKeys.round("pf-1"))).toMatchObject({ state: "done" });
  });

  it("never settles → gives up at the deadline as a failure", async () => {
    syncAccount.mockResolvedValue({
      queued: true,
      accountId: ACC,
      portfolioId: "pf-1",
      roundId: "r1",
      round: view(),
    });
    getSyncRound.mockResolvedValue(view());
    const client = new QueryClient();

    await expect(syncAccountAndWait(client, ACC, { pollMs: 1, timeoutMs: 5 })).resolves.toEqual({
      accountId: ACC,
      ok: false,
    });
  });

  it("request itself fails → rejects (caller's onError path)", async () => {
    syncAccount.mockRejectedValue(new Error("network"));
    await expect(syncAccountAndWait(new QueryClient(), ACC)).rejects.toThrow("network");
  });
});

// Consumers renew the heartbeat before each attempt, so the round stays running through the whole retry
// chain; giving up earlier shows a generic failure while the server settles later. Must outlast the chain.
describe("ACCOUNT_SYNC_TIMEOUT_MS", () => {
  it("outlasts the runner's worst-case retry chain (4 × 80s + backoff 30 + 60 + 120s + 3 × 10s slack = 560s)", () => {
    expect(JOB_MAX_RETRIES).toBe(3);
    expect([1, 2, 3].map(jobRetryDelayMs)).toEqual([30_000, 60_000, 120_000]);
    expect(SYNC_RETRY_CHAIN_MS).toBe(560_000);
    expect(ACCOUNT_SYNC_TIMEOUT_MS).toBeGreaterThan(SYNC_RETRY_CHAIN_MS);
  });
});
