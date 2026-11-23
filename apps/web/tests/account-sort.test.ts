import { describe, expect, it } from "vitest";
import { sortActiveAccounts } from "@/routes/_authed/-accounts/list-rows";

describe("sortActiveAccounts", () => {
  it("sorts by value descending (no special tiers)", () => {
    const rows = [
      { id: "a", totalUsd: 100 },
      { id: "b", totalUsd: 0 },
      { id: "c", totalUsd: 500 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps relative order on equal values (stable)", () => {
    const rows = [
      { id: "x", totalUsd: 50 },
      { id: "y", totalUsd: 50 },
      { id: "z", totalUsd: 100 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["z", "x", "y"]);
  });

  it("does not mutate the input (returns a new array)", () => {
    const rows = [
      { id: "a", totalUsd: 100 },
      { id: "c", totalUsd: 500 },
    ];
    const sorted = sortActiveAccounts(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]); // input unchanged
    expect(sorted.map((r) => r.id)).toEqual(["c", "a"]);
  });
});
