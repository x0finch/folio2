import { describe, expect, it } from "vitest";
import { tokenTicket } from "../src";

// A ticket is a tokenRef handed to the browser in opaque form. Round trip, and "anything from the network is untrusted" at two levels:
// (1) undecodable or not a valid ref gives undefined (grammar); (2) decodable and valid but not the namer we issued gives undefined
// (trust), the reason decoding must take `namer` (see src/ticket.ts).

const NAMER = "coingecko";

// Each namer follows its ref (round trip does not depend on the namer, only that it names the issuer correctly).
const REFS: [ref: string, namer: string][] = [
  ["coingecko/issued:usd-coin", "coingecko"],
  ["evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "evm:1"],
  ["bitcoin/native", "bitcoin"],
  ["binance/issued:BTC", "binance"],
  ["manual/custom:MY-PRIVATE-TOKEN", "manual"],
];

describe("round trip", () => {
  it.each(REFS)("%s encodes back to itself", (ref, namer) => {
    expect(tokenTicket.decode(tokenTicket.encode(ref), namer)).toBe(ref);
  });

  it("the encoded string goes straight into a URL: none of the three characters + / =", () => {
    for (const [ref] of REFS) {
      expect(tokenTicket.encode(ref)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("non-ASCII symbols round trip too (TextEncoder, not charCode)", () => {
    const ref = "manual/custom:比特币";
    expect(tokenTicket.decode(tokenTicket.encode(ref), "manual")).toBe(ref);
  });

  it("different refs give different tickets: the front end uses them as keys / same-token checks", () => {
    expect(new Set(REFS.map(([ref]) => tokenTicket.encode(ref))).size).toBe(REFS.length);
  });

  // Decoding yields the canonical form, not the raw string: the ref goes straight into mint and token_refs, which hold canonical forms only.
  it("a non-canonical ticket decodes to the canonical form", () => {
    expect(tokenTicket.decode(tokenTicket.encode("CoinGecko/ISSUED:usd-coin"), NAMER)).toBe(
      "coingecko/issued:usd-coin",
    );
    expect(tokenTicket.decode(tokenTicket.encode("manual/custom:usdc"), "manual")).toBe(
      "manual/custom:USDC",
    );
  });
});

describe("undecodable is always undefined: a ticket comes from the network", () => {
  it("empty string / characters outside base64url", () => {
    expect(tokenTicket.decode("", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("!!!not-base64!!!", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("has spaces", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("a+b/c=", NAMER)).toBeUndefined(); // the three plain-base64 characters are rejected
  });

  it("decodable but not a valid ref inside", () => {
    // One segment has no namer; three segments: the grammar accepts exactly two.
    expect(tokenTicket.decode(tokenTicket.encode("bitcoin"), NAMER)).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode("a/b/c"), NAMER)).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode(""), NAMER)).toBeUndefined();
  });
});

// Mismatched namer is rejected
// A ticket is unsigned (anyone can base64url-encode one), so "issued by us" is proven by content: its namer must be the current one.
// Otherwise a hand-forged `<any>/issued:<any>` would let mint treat a user-typed symbol as a trusted hint.
describe("namer mismatch is rejected (`issued` is a claim and must be verified)", () => {
  it("all four grammar shapes are treated alike: another shape cannot bypass it", () => {
    for (const ref of [
      "evil/native",
      "evil/contract:0xdead",
      "evil/issued:x",
      "evil/custom:USDC",
    ]) {
      expect(tokenTicket.decode(tokenTicket.encode(ref), NAMER)).toBeUndefined();
    }
  });

  it("namers are compared in canonical form (case / whitespace do not matter)", () => {
    const t = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, "CoinGecko")).toBe("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, "  coingecko  ")).toBe("coingecko/issued:usd-coin");
  });

  it("when the upstream changes, old tickets stop working (instead of silently pointing at another vendor's id)", () => {
    const old = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(old, "someother-source")).toBeUndefined();
  });
});

// A set of namers: tickets are issued under more than one namer (upstream for crypto, `fiat` for fiat); a set means "namer must be one of these".
// This is the key check of end-to-end fiat accounting: mintHolding decodes with `[coingecko, fiat]`, and a fiat ticket must decode
// back to `fiat/issued:<CODE>`, or submission falls back to custom and builds no fiat row.
describe("a set of namers (fiat tickets are ours too)", () => {
  const NAMERS = ["coingecko", "fiat"] as const;

  it("a fiat ticket in the set decodes back to fiat/issued:<CODE>", () => {
    const t = tokenTicket.encode("fiat/issued:USD");
    expect(tokenTicket.decode(t, NAMERS)).toBe("fiat/issued:USD");
    expect(tokenTicket.decode(t, "fiat")).toBe("fiat/issued:USD");
  });

  it("the same set still accepts the current upstream's crypto tickets", () => {
    const t = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, NAMERS)).toBe("coingecko/issued:usd-coin");
  });

  it("coingecko alone (the old signature): a fiat ticket is rejected, the path that fell back to custom", () => {
    const t = tokenTicket.encode("fiat/issued:USD");
    expect(tokenTicket.decode(t, "coingecko")).toBeUndefined();
  });

  it("a foreign namer outside the set is still blocked (widening to a set does not weaken the check)", () => {
    const forged = tokenTicket.encode("evil/issued:whatever");
    expect(tokenTicket.decode(forged, NAMERS)).toBeUndefined();
  });
});
