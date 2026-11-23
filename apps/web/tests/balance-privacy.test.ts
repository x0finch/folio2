import { describe, expect, it } from "vitest";
import {
  isHidden,
  type PrivacyState,
  parseCachedHideBalances,
  privacyReducer,
  resolveInitialEnabled,
  serializeHideBalances,
} from "@/lib/hooks/balance-privacy";

const S = (enabled: boolean, revealed: boolean): PrivacyState => ({ enabled, revealed });

describe("isHidden", () => {
  it("privacy on, not revealed → hidden", () => {
    expect(isHidden(S(true, false))).toBe(true);
  });
  it("privacy on, revealed → shown", () => {
    expect(isHidden(S(true, true))).toBe(false);
  });
  it("privacy off → never hidden", () => {
    expect(isHidden(S(false, false))).toBe(false);
    expect(isHidden(S(false, true))).toBe(false);
  });
});

describe("resolveInitialEnabled (fail-closed + cache)", () => {
  it("no cache → assume on (fail-closed, hide first)", () => {
    expect(resolveInitialEnabled(null)).toBe(true);
  });
  it("cache ON → on (hide immediately, no flash)", () => {
    expect(resolveInitialEnabled(true)).toBe(true);
  });
  it("cache OFF → off (no hiding, no flash)", () => {
    expect(resolveInitialEnabled(false)).toBe(false);
  });
});

describe("privacyReducer: reveal", () => {
  it("reveal with privacy on → temporarily shown", () => {
    expect(privacyReducer(S(true, false), { type: "reveal" })).toEqual(S(true, true));
  });
  it("reveal with privacy off → no-op, same reference", () => {
    const s = S(false, false);
    expect(privacyReducer(s, { type: "reveal" })).toBe(s);
  });
  it("reveal while already revealed → same reference", () => {
    const s = S(true, true);
    expect(privacyReducer(s, { type: "reveal" })).toBe(s);
  });
});

describe("privacyReducer: leave ends the temporary reveal", () => {
  it("any leave while revealed → hidden again", () => {
    expect(privacyReducer(S(true, true), { type: "leave" })).toEqual(S(true, false));
  });
  it("not revealed → same reference", () => {
    const s = S(true, false);
    expect(privacyReducer(s, { type: "leave" })).toBe(s);
  });
});

describe("privacyReducer: sync", () => {
  it("server/cache says on → enabled=true", () => {
    expect(privacyReducer(S(false, false), { type: "sync", hideBalances: true })).toEqual(
      S(true, false),
    );
  });
  it("server says off → enabled=false and clears a pending reveal", () => {
    expect(privacyReducer(S(true, true), { type: "sync", hideBalances: false })).toEqual(
      S(false, false),
    );
  });
  it("unchanged (still on, still revealed) → same reference, current reveal kept", () => {
    const s = S(true, true);
    expect(privacyReducer(s, { type: "sync", hideBalances: true })).toBe(s);
  });
});

describe("cache serialization", () => {
  it("round trip", () => {
    expect(parseCachedHideBalances(serializeHideBalances(true))).toBe(true);
    expect(parseCachedHideBalances(serializeHideBalances(false))).toBe(false);
  });
  it("missing / garbage → null (treated as no cache → fail-closed)", () => {
    expect(parseCachedHideBalances(null)).toBeNull();
    expect(parseCachedHideBalances("")).toBeNull();
    expect(parseCachedHideBalances("true")).toBeNull();
  });
});
