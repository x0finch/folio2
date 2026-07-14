import { describe, expect, it } from "vitest";
import { type SyncAccountInput, summarizeSync } from "../src/lib/sync-status";

const acc = (over: Partial<SyncAccountInput>): SyncAccountInput => ({
  id: crypto.randomUUID(),
  label: "wallet",
  archivedAt: null,
  complete: true,
  takenAt: null,
  ...over,
});

describe("summarizeSync", () => {
  it("counts ok = active accounts with complete creds", () => {
    const s = summarizeSync([acc({ complete: true }), acc({ complete: true })]);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(2);
    expect(s.failed).toEqual([]);
  });

  it("lists incomplete-cred accounts as failed and drops them from ok", () => {
    const s = summarizeSync([
      acc({ id: "a", label: "Zerion", complete: false }),
      acc({ id: "b", label: "OKX", complete: true }),
    ]);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.failed).toEqual([{ id: "a", label: "Zerion" }]);
  });

  it("excludes archived accounts from every tally", () => {
    const s = summarizeSync([
      acc({ id: "a", complete: true, takenAt: 100 }),
      acc({ id: "z", archivedAt: 5, complete: false, takenAt: 999 }),
    ]);
    expect(s.total).toBe(1);
    expect(s.accounts).toEqual([{ id: "a", label: "wallet" }]);
    expect(s.failed).toEqual([]);
    // 归档账户的 takenAt(999)不得污染 lastSyncedAt
    expect(s.lastSyncedAt).toBe(100);
  });

  it("takes the newest snapshot time across active accounts", () => {
    const s = summarizeSync([acc({ takenAt: 100 }), acc({ takenAt: 300 }), acc({ takenAt: null })]);
    expect(s.lastSyncedAt).toBe(300);
  });

  it("lastSyncedAt is null when no active account has ever synced", () => {
    const s = summarizeSync([acc({ takenAt: null }), acc({ takenAt: null })]);
    expect(s.lastSyncedAt).toBeNull();
  });

  it("handles an empty account set", () => {
    const s = summarizeSync([]);
    expect(s).toEqual({ accounts: [], total: 0, ok: 0, failed: [], lastSyncedAt: null });
  });
});
