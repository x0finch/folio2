import { describe, expect, it } from "vitest";
import { buildAccountRows } from "@/routes/_authed/-accounts/list-rows";

const account = (over: Partial<Parameters<typeof buildAccountRows>[0]["accounts"][number]> = {}) =>
  ({
    id: "a1",
    label: "Binance",
    connectorId: "binance",
    archivedAt: null,
    needsCredentials: false,
    credsSafe: {},
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: test double only supplies the fields assembly reads
  }) as any;

const build = (over: Partial<Parameters<typeof buildAccountRows>[0]> = {}) =>
  buildAccountRows({
    accounts: [account()],
    // biome-ignore lint/suspicious/noExplicitAny: test double
    holdings: { rows: [] } as any,
    allTags: [],
    tagLinks: [],
    ...over,
  });

describe("buildAccountRows", () => {
  it("holdings not loaded → valuesReady false, value is not a real 0", () => {
    const [row] = build({ holdings: undefined });
    expect(row.valuesReady).toBe(false);
  });

  it("account missing from holdings → value/last sync/holdings fall back to empty, row stays", () => {
    // Fallback for accounts with no snapshot yet. Archived accounts carry a frozen value (next test).
    const [row] = build({ accounts: [account({ archivedAt: 1700000000000 })] });
    expect(row.valuesReady).toBe(true);
    expect(row.totalUsd).toBe(0);
    expect(row.takenAt).toBeNull();
    expect(row.balances).toEqual([]);
    expect(row.archivedAt).toBe(1700000000000);
  });

  it("archived account has a frozen value in holdings → used as-is, not zeroed", () => {
    const [row] = build({
      accounts: [account({ archivedAt: 1700000000000 })],
      holdings: {
        rows: [
          { account: { id: "a1" }, totalUsd: 999, takenAt: 1690000000000, balances: [{ x: 1 }] },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: test double
      } as any,
    });
    expect(row.archivedAt).toBe(1700000000000);
    expect(row.valuesReady).toBe(true);
    expect(row.totalUsd).toBe(999);
    expect(row.takenAt).toBe(1690000000000);
    expect(row.balances).toHaveLength(1);
  });

  it("account present in holdings → value and last sync come from it", () => {
    const [row] = build({
      holdings: {
        rows: [{ account: { id: "a1" }, totalUsd: 1234, takenAt: 42, balances: [{ x: 1 }] }],
        // biome-ignore lint/suspicious/noExplicitAny: test double
      } as any,
    });
    expect(row.totalUsd).toBe(1234);
    expect(row.takenAt).toBe(42);
    expect(row.balances).toHaveLength(1);
  });

  it("tags resolve by id; links to deleted tags are skipped (no ghost tags)", () => {
    const [row] = build({
      allTags: [{ id: "t1", name: "longterm", portfolioId: "p1" }],
      tagLinks: [
        { accountId: "a1", tagId: "t1" },
        { accountId: "a1", tagId: "ghost" },
        { accountId: "other", tagId: "t1" },
      ],
    });
    expect(row.tags).toEqual([{ id: "t1", name: "longterm" }]);
  });

  // Membership arrives with the account row (server filters by portfolio), so it is passed through.
  it("membership passes through from the account row", () => {
    expect(build({ accounts: [account({ portfolioId: "p9" })] })[0].portfolioId).toBe("p9");
  });
});
