import { describe, expect, it } from "vitest";
import { pickSelectedPortfolio, portfolioSwitchSearch } from "@/lib/hooks/use-portfolio";

// The selected Portfolio lives in the URL.

const DEFAULT = "pf-default";
const WATCH = "pf-watch";
const LIST = [{ id: DEFAULT }, { id: WATCH }];

describe("pickSelectedPortfolio", () => {
  it("selects whatever the URL names", () => {
    expect(pickSelectedPortfolio(WATCH, LIST, DEFAULT)).toBe(WATCH);
  });

  it("param absent -> the default one", () => {
    expect(pickSelectedPortfolio(undefined, LIST, DEFAULT)).toBe(DEFAULT);
  });

  // Someone else's id is just an unknown id here (only the user's own are listed): no probe signal.
  it("unknown id (including someone else's) -> quietly falls back to default (stale bookmarks get a view)", () => {
    expect(pickSelectedPortfolio("pf-deleted", LIST, DEFAULT)).toBe(DEFAULT);
  });

  // The route validator rejects these (`.catch(undefined)`), but the `_authed` loader reads the
  // raw parse, so a hand-edited URL can produce them.
  it("malformed (empty / repeated param / number) -> treated as absent", () => {
    expect(pickSelectedPortfolio("", LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio([WATCH, DEFAULT], LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio(123, LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio(null, LIST, DEFAULT)).toBe(DEFAULT);
  });
});

describe("portfolioSwitchSearch", () => {
  it("non-default portfolio is written to the URL", () => {
    expect(portfolioSwitchSearch(WATCH, DEFAULT)).toEqual({ portfolio: WATCH });
  });

  it("default portfolio is not written (value undefined, key still present)", () => {
    const next = portfolioSwitchSearch(DEFAULT, DEFAULT);
    expect(next.portfolio).toBeUndefined();
    // The key must be present: `retainSearchParams` only restores old values for absent keys.
    expect("portfolio" in next).toBe(true);
  });

  it("drops every param from the old portfolio (a fresh search, not one key changed)", () => {
    // Assert the key set, not each `toBeUndefined`, so a future in-page param cannot leak in.
    expect(Object.keys(portfolioSwitchSearch(WATCH, DEFAULT))).toEqual(["portfolio"]);
  });
});
