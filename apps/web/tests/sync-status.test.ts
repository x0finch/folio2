import { describe, expect, it } from "vitest";
import { type SyncAccountInput, summarizeSync } from "../src/lib/core/sync-status";

// 夹具默认「已同步过」(takenAt 有值)——「从未同步」必须由用例显式写出来,
// 否则整张表会默默漂进那一档,而那正是本文件上一版把 bug 固化住的方式:
// 默认 takenAt: null,却断言 ok=2。
const acc = (over: Partial<SyncAccountInput>): SyncAccountInput => ({
  id: crypto.randomUUID(),
  label: "wallet",
  archivedAt: null,
  complete: true,
  takenAt: 1000,
  ...over,
});

describe("summarizeSync", () => {
  it("counts ok = accounts that have actually synced", () => {
    const s = summarizeSync([acc({ takenAt: 1000 }), acc({ takenAt: 2000 })]);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(2);
    expect(s.failed).toEqual([]);
  });

  // UI 说的是「Sources synced」。一个刚加进来、凭据齐全、但一次都没拉过数据的账户
  // 曾被算进 ok,于是面板显示「All synced 2/2」而账户行上写着「Never synced」。
  it("a never-synced account is not ok, even with complete creds", () => {
    const s = summarizeSync([
      acc({ id: "a", label: "regression evm", takenAt: null }),
      acc({ id: "b", label: "H1", takenAt: 1000 }),
    ]);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.failed).toEqual([{ id: "a", label: "regression evm", reason: "never-synced" }]);
  });

  it("lists incomplete-cred accounts as failed and drops them from ok", () => {
    const s = summarizeSync([
      acc({ id: "a", label: "Zerion", complete: false }),
      acc({ id: "b", label: "OKX", complete: true }),
    ]);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.failed).toEqual([{ id: "a", label: "Zerion", reason: "missing-credentials" }]);
  });

  // 两个毛病都有 → 只报一条,报根因:凭据都没配齐,「从未同步」是它的后果而非独立问题。
  it("reports missing creds once, not twice, when it also never synced", () => {
    const s = summarizeSync([acc({ id: "a", label: "OKX", complete: false, takenAt: null })]);
    expect(s.ok).toBe(0);
    expect(s.failed).toEqual([{ id: "a", label: "OKX", reason: "missing-credentials" }]);
  });

  it("keeps ok + failed.length === total", () => {
    const s = summarizeSync([
      acc({ complete: false }),
      acc({ takenAt: null }),
      acc({ takenAt: 500 }),
    ]);
    expect(s.ok + s.failed.length).toBe(s.total);
    expect(s.ok).toBe(1);
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
