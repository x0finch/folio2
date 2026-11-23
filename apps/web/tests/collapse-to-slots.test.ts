import { describe, expect, it } from "vitest";
import { collapseToSlots } from "@/components/tag-badges";

// max = slots in total, and the "+N" tail takes one of them. The boundary (exactly max) is the easy bug.

const items = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

describe("collapseToSlots", () => {
  it("exactly max → no collapse, all shown", () => {
    expect(collapseToSlots(items(3), 3)).toEqual({ shown: ["i0", "i1", "i2"], overflow: 0 });
  });

  it("over max → last slot goes to the tail", () => {
    expect(collapseToSlots(items(4), 3)).toEqual({ shown: ["i0", "i1"], overflow: 2 });
    expect(collapseToSlots(items(9), 3)).toEqual({ shown: ["i0", "i1"], overflow: 7 });
  });

  it("no max = no collapse", () => {
    expect(collapseToSlots(items(9), undefined).overflow).toBe(0);
  });

  // Callers may pass only the top items (real count in `total`): collapse and remainder use total, not items.length.
  it("separate total: drives the collapse and the remainder", () => {
    expect(collapseToSlots(items(3), 3, 3)).toEqual({ shown: ["i0", "i1", "i2"], overflow: 0 });
    expect(collapseToSlots(items(3), 3, 9)).toEqual({ shown: ["i0", "i1"], overflow: 7 });
  });

  it("empty list", () => {
    expect(collapseToSlots([], 3)).toEqual({ shown: [], overflow: 0 });
  });
});
