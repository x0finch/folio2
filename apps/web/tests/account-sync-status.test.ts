import type { AccountSafe } from "@folio/db";
import { describe, expect, it } from "vitest";
import { accountSyncStatus, isSyncableAccount, STALE_SYNC_MS } from "@/lib/server/sync/status";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("accountSyncStatus", () => {
  it("missing creds wins (even right after a sync) → needsCreds", () => {
    expect(accountSyncStatus({ needsCredentials: true, takenAt: NOW - HOUR }, NOW)).toBe(
      "needsCreds",
    );
  });

  it("no snapshot (takenAt=null) and creds complete → never", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: null }, NOW)).toBe("never");
  });

  // Threshold is 3 days: syncing is manual, and this also drives the header badge's amber state.
  it("synced too long ago (past threshold) → stale", () => {
    expect(
      accountSyncStatus({ needsCredentials: false, takenAt: NOW - STALE_SYNC_MS - 1 }, NOW),
    ).toBe("stale");
  });

  it("recent sync (within threshold) → fresh", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: NOW - HOUR }, NOW)).toBe("fresh");
  });

  it("exactly at the threshold → still fresh (stale only when strictly past)", () => {
    expect(accountSyncStatus({ needsCredentials: false, takenAt: NOW - STALE_SYNC_MS }, NOW)).toBe(
      "fresh",
    );
  });
});

type A = Pick<AccountSafe, "archivedAt" | "connectorId">;
const a = (over: Partial<A>): A => ({ archivedAt: null, connectorId: "bitcoin", ...over });

describe("isSyncableAccount", () => {
  it("active non-manual accounts are syncable", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin" }))).toBe(true);
    expect(isSyncableAccount(a({ connectorId: "evm" }))).toBe(true);
  });

  it("manual is not a sync source → excluded", () => {
    expect(isSyncableAccount(a({ connectorId: "manual" }))).toBe(false);
  });

  it("archived accounts excluded (even non-manual)", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin", archivedAt: 123 }))).toBe(false);
  });
});
