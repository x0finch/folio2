import { describe, expect, it } from "vitest";
import { STALE_SYNC_MS, type SyncAccountInput, summarizeSync } from "@/lib/server/sync/status";

//
const NOW = 5_000;

const acc = (over: Partial<SyncAccountInput>): SyncAccountInput => ({
  id: crypto.randomUUID(),
  label: "wallet",
  connectorId: "evm",
  archivedAt: null,
  complete: true,
  takenAt: 1000,
  ...over,
});

describe("summarizeSync", () => {
  it("all synced: list is empty", () => {
    const s = summarizeSync([acc({ takenAt: 1000 }), acc({ takenAt: 2000 })], NOW);
    expect(s.total).toBe(2);
    expect(s.attention).toEqual([]);
  });

  it("a never-synced account is not ok, even with complete creds", () => {
    const s = summarizeSync(
      [
        acc({ id: "a", label: "regression evm", takenAt: null }),
        acc({ id: "b", label: "H1", takenAt: 1000 }),
      ],
      NOW,
    );
    expect(s.total).toBe(2);
    expect(s.attention).toEqual([
      {
        id: "a",
        label: "regression evm",
        connectorId: "evm",
        kind: "never-synced",
        takenAt: null,
      },
    ]);
  });

  it("lists incomplete-cred accounts and drops them from ok", () => {
    const s = summarizeSync(
      [acc({ id: "a", label: "Zerion", complete: false }), acc({ id: "b", label: "OKX" })],
      NOW,
    );
    expect(s.total).toBe(2);
    expect(s.attention.map((a) => [a.id, a.kind])).toEqual([["a", "missing-credentials"]]);
  });

  it("reports missing creds once, not twice, when it also never synced", () => {
    const s = summarizeSync([acc({ id: "a", complete: false, takenAt: null })], NOW);
    expect(s.attention.map((a) => a.kind)).toEqual(["missing-credentials"]);
  });

  it("excludes archived accounts from every tally", () => {
    const s = summarizeSync(
      [acc({ id: "a", takenAt: 100 }), acc({ id: "z", archivedAt: 5, complete: false })],
      NOW,
    );
    expect(s.total).toBe(1);
    expect(s.accounts).toEqual([{ id: "a", label: "wallet" }]);
    expect(s.attention).toEqual([]);
    expect(s.lastSyncedAt).toBe(100);
  });

  it("takes the newest snapshot time across active accounts", () => {
    const s = summarizeSync(
      [acc({ takenAt: 100 }), acc({ takenAt: 300 }), acc({ takenAt: null })],
      NOW,
    );
    expect(s.lastSyncedAt).toBe(300);
  });

  it("lastSyncedAt is null when no active account has ever synced", () => {
    const s = summarizeSync([acc({ takenAt: null }), acc({ takenAt: null })], NOW);
    expect(s.lastSyncedAt).toBeNull();
  });

  it("handles an empty account set", () => {
    const s = summarizeSync([], NOW);
    expect(s).toEqual({
      accounts: [],
      total: 0,
      attention: [],
      lastSyncedAt: null,
      dataStale: false,
    });
  });

  describe("stale", () => {
    const now = 1_000_000_000_000;
    const old = (over: Partial<SyncAccountInput>) => acc({ takenAt: now - 1000, ...over });

    it("just past the threshold: listed, but still counts as ok (has data, merely old)", () => {
      const s = summarizeSync(
        [old({ id: "a", label: "OKX", takenAt: now - STALE_SYNC_MS - 1 })],
        now,
      );
      expect(s.attention.map((a) => [a.id, a.kind])).toEqual([["a", "stale"]]);
    });

    it("exactly at the threshold: not stale yet (boundary excluded)", () => {
      const s = summarizeSync([old({ takenAt: now - STALE_SYNC_MS })], now);
      expect(s.attention).toEqual([]);
    });

    it("list sorted by severity: missing credentials, never synced, stale", () => {
      const s = summarizeSync(
        [
          old({ id: "stale", takenAt: now - 10 * STALE_SYNC_MS }),
          old({ id: "never", takenAt: null }),
          old({ id: "creds", complete: false }),
        ],
        now,
      );
      expect(s.attention.map((a) => a.id)).toEqual(["creds", "never", "stale"]);
      expect(s.total).toBe(3);
    });

    it("within a tier the older comes first", () => {
      const s = summarizeSync(
        [
          old({ id: "newer", takenAt: now - 2 * STALE_SYNC_MS }),
          old({ id: "oldest", takenAt: now - 9 * STALE_SYNC_MS }),
        ],
        now,
      );
      expect(s.attention.map((a) => a.id)).toEqual(["oldest", "newer"]);
    });

    it("missing credentials is not also reported as stale: an account appears once", () => {
      const s = summarizeSync(
        [old({ id: "a", complete: false, takenAt: now - 10 * STALE_SYNC_MS })],
        now,
      );
      expect(s.attention.map((a) => a.kind)).toEqual(["missing-credentials"]);
    });

    it("archived accounts are not listed (they do not sync)", () => {
      const s = summarizeSync([old({ archivedAt: 1, takenAt: now - 10 * STALE_SYNC_MS })], now);
      expect(s.attention).toEqual([]);
      expect(s.total).toBe(0);
    });
  });

  describe("dataStale (overall data too old)", () => {
    const WARN = 26 * 60 * 60 * 1000;
    const now = 1_000_000_000_000;

    it("latest snapshot older than 26 hours: dataStale, even with no account in attention", () => {
      const s = summarizeSync([acc({ takenAt: now - 42 * 60 * 60 * 1000 })], now);
      expect(s.attention).toEqual([]);
      expect(s.dataStale).toBe(true);
    });

    it("latest snapshot within 26 hours: not stale, even if another account is very old", () => {
      const s = summarizeSync(
        [acc({ id: "new", takenAt: now - 1000 }), acc({ id: "old", takenAt: now - WARN - 1 })],
        now,
      );
      expect(s.dataStale).toBe(false);
    });

    it("never synced: not stale (left to the never-synced entry, no double warning)", () => {
      const s = summarizeSync([acc({ takenAt: null })], now);
      expect(s.dataStale).toBe(false);
    });
  });

  describe("manual accounts", () => {
    it('manual accounts only: counts as one source, but "sync now" has nothing to sync', () => {
      const s = summarizeSync([acc({ connectorId: "manual", takenAt: null })], NOW);
      expect(s.total).toBe(1);
      expect(s.accounts).toEqual([]);
      expect(s.attention).toEqual([]);
    });

    it('not listed as "never synced": it does not sync at all', () => {
      const s = summarizeSync(
        [acc({ id: "m", connectorId: "manual", takenAt: null }), acc({ id: "c", takenAt: 1000 })],
        NOW,
      );
      expect(s.attention).toEqual([]);
      expect(s.total).toBe(2);
      expect(s.accounts.map((a) => a.id)).toEqual(["c"]);
    });

    it('its takenAt does not pollute "last updated"', () => {
      const s = summarizeSync(
        [acc({ connectorId: "manual", takenAt: 4000 }), acc({ takenAt: 100 })],
        NOW,
      );
      expect(s.lastSyncedAt).toBe(100);
    });
  });
});
