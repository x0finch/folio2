import { describe, expect, it } from "vitest";
import { incompleteSpecs } from "../src/lib/incomplete-specs";
import type { InputSpec } from "../src/lib/server/credentials";

// 补录只问"能被 isComplete gate 的字段" = 非 public(semi + secret)。public 已知/导入带真值,不重问。
const SPECS: InputSpec[] = [
  { key: "address", type: "public", label: "Address" },
  { key: "apiKey", type: "semi", label: "API Key" },
  { key: "apiSecret", type: "secret", label: "API Secret" },
];

describe("incompleteSpecs", () => {
  it("keeps only non-public specs (semi + secret)", () => {
    expect(incompleteSpecs(SPECS).map((s) => s.key)).toEqual(["apiKey", "apiSecret"]);
  });

  it("preserves original order", () => {
    const specs: InputSpec[] = [
      { key: "secret", type: "secret", label: "S" },
      { key: "pub", type: "public", label: "P" },
      { key: "semi", type: "semi", label: "M" },
    ];
    expect(incompleteSpecs(specs).map((s) => s.key)).toEqual(["secret", "semi"]);
  });

  it("returns empty when every spec is public (on-chain never needs credentials)", () => {
    const specs: InputSpec[] = [{ key: "addressOrXpub", type: "public", label: "Bitcoin address" }];
    expect(incompleteSpecs(specs)).toEqual([]);
  });

  it("returns empty for no specs", () => {
    expect(incompleteSpecs([])).toEqual([]);
  });
});
