import { describe, expect, it } from "vitest";
import {
  formatTokenRef,
  hasTrustedSymbol,
  parseTokenRef,
  type TokenRefParts,
  tokenRef,
} from "../src";
import cases from "./fixtures/token-ref-cases.json" with { type: "json" };

// tokenRef grammar. The case table is in fixtures/token-ref-cases.json (input, expected output, why each is there);
// this file only says how to assert against it. Two tables, one per direction: `construct` (structure to string) and
// `parse` (string to structure, `parsed: null` = unreadable). Each parse case is checked three ways: the split structure,
// formatting back from the semantic form, and from the two-segment form; the last two must agree.

interface ConstructCase {
  note: string;
  kind: "native" | "contract" | "issued" | "custom";
  namer: string;
  value?: string;
  ref: string;
}

interface ParseCase {
  note: string;
  raw: string;
  // Defaults to raw; when given, raw is not canonical and formatting back yields it.
  canonical?: string;
  // null = unreadable (kind is unknown).
  parsed: Record<string, string> | null;
}

const { construct, parse } = cases as { construct: ConstructCase[]; parse: ParseCase[] };

// The table needs a floor: if the fixture were emptied, every `it.each` below would pass with zero cases.
describe("case table", () => {
  it("neither table is empty (an empty one would make every it.each assert nothing)", () => {
    expect(construct.length).toBeGreaterThan(5);
    expect(parse.filter((c) => c.parsed !== null).length).toBeGreaterThan(5);
    expect(parse.filter((c) => c.parsed === null).length).toBeGreaterThan(5);
  });
});

// Construction: the caller gives structure, the constructor sets `kind`
describe("tokenRef.* constructors", () => {
  const build = ({ kind, namer, value }: ConstructCase): string => {
    switch (kind) {
      case "native":
        return tokenRef.native(namer);
      case "contract":
        return tokenRef.contract(namer, value as string);
      case "issued":
        return tokenRef.issued(namer, value as string);
      case "custom":
        return tokenRef.custom(namer, value as string);
    }
  };

  it.each(construct)("$kind — $note", (c) => {
    expect(build(c)).toBe(c.ref);
  });

  it("a built string parses back to the same structure (construction and parsing share one normalisation)", () => {
    for (const c of construct) {
      const parsed = parseTokenRef(c.ref);
      expect(parsed.kind).toBe(c.kind);
      if (parsed.kind !== "unknown") expect(formatTokenRef(parsed)).toBe(c.ref);
    }
  });
});

// Parsing
const readable = parse.filter((c) => c.parsed !== null);
const unreadable = parse.filter((c) => c.parsed === null);

describe("parseTokenRef", () => {
  it.each(readable)("$raw — $note", ({ raw, parsed }) => {
    expect(parseTokenRef(raw)).toEqual(parsed);
  });

  // Unreadable strings are always unknown and never throw: any string needs a home.
  it.each(unreadable)("$raw → unknown — $note", ({ raw }) => {
    expect(() => parseTokenRef(raw)).not.toThrow();
    expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
  });
});

// Formatting back: one formatTokenRef, two input forms, same result
// The semantic form is for when the thing is known (change a field, format back); the two-segment form is for the two-column
// `token_refs` table, so storage need not know `native` / `contract:` or the separator.
describe("formatTokenRef", () => {
  it.each(readable)("$raw: both input forms format to the same canonical form", ({
    raw,
    canonical,
    parsed,
  }) => {
    const want = canonical ?? raw;
    const got = parseTokenRef(raw);
    expect(got.kind).not.toBe("unknown");
    if (got.kind === "unknown") return;

    expect(formatTokenRef(got)).toBe(want); // semantic form
    expect(formatTokenRef({ namer: got.namer, localName: got.localName })).toBe(want); // two-segment form
    // localName and the branch's own field say the same thing.
    expect(got.localName).toBe((parsed as Record<string, string>).localName);
  });

  it("normalisation is idempotent: parse, format, parse again changes nothing", () => {
    for (const { raw } of readable) {
      const once = parseTokenRef(raw);
      if (once.kind === "unknown") continue;
      expect(parseTokenRef(formatTokenRef(once))).toEqual(once);
    }
  });

  // The other direction, from the constructor input (`TokenRefParts`, no localName); parse's output is a superset, so identity holds on the constructor fields only.
  it("parse then format is identity on the constructor fields", () => {
    const parts: TokenRefParts[] = [
      { kind: "contract", namer: "evm:1", address: "0xabc" },
      {
        kind: "contract",
        namer: "solana",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      { kind: "native", namer: "bitcoin" },
      { kind: "issued", namer: "coingecko", id: "usd-coin" },
      { kind: "custom", namer: "manual", name: "MYCOIN" },
    ];
    for (const p of parts) {
      const parsed = parseTokenRef(formatTokenRef(p));
      expect(parsed).toMatchObject(p);
    }
  });
});

// Whether the symbol this ref carries has a voucher. The criterion lives in the grammar, not in each caller's switch.
// The table is a hand-written literal, not derived from kind, or it would only follow the implementation.
describe("hasTrustedSymbol", () => {
  const table = [
    {
      ref: "bitcoin/native",
      trusted: true,
      note: "native coin: the symbol is the chain's own, and native coins are by design not in the map, so symbol is their only route",
    },
    {
      ref: "binance/issued:USDC",
      trusted: true,
      note: "venue ticker: binance vouches for the identifier",
    },
    {
      ref: "coingecko/issued:usd-coin",
      trusted: true,
      note: "upstream coin id: the namer is the issuer",
    },
    {
      ref: "evm:1/contract:0xabc",
      trusted: false,
      note: "a contract's symbol is deployer-chosen: a fake contract can write USDC",
    },
    {
      ref: "manual/custom:USDC",
      trusted: false,
      note: "typed by the user with no registry behind it",
    },
    {
      ref: "nonsense",
      trusted: false,
      note: "unreadable: we know nothing, the worst thing to guess",
    },
  ];

  it.each(table)("$ref → $trusted — $note", ({ ref, trusted }) => {
    expect(hasTrustedSymbol(parseTokenRef(ref))).toBe(trusted);
  });
});
