import { describe, expect, it } from "vitest";
import { incompleteSpecs } from "@/components/incomplete-specs";
import type { InputSpec } from "@/lib/server/creds";

const SPECS: InputSpec[] = [
  { key: "address", type: "public", label: "Address" },
  { key: "apiKey", type: "semi", label: "API Key" },
  { key: "apiSecret", type: "secret", label: "API Secret" },
];

describe("incompleteSpecs", () => {
  it("keeps non-public specs (semi + secret) when the public ones are known", () => {
    expect(incompleteSpecs(SPECS, { address: "0xabc" }).map((s) => s.key)).toEqual([
      "apiKey",
      "apiSecret",
    ]);
  });

  it("also asks for a required public field the account lacks, never an optional one", () => {
    const specs: InputSpec[] = [
      { key: "config", type: "public", label: "Config" },
      { key: "address", type: "public", label: "Address", optional: true },
      { key: "apiKey", type: "secret", label: "Key", optional: true },
    ];
    expect(incompleteSpecs(specs).map((s) => s.key)).toEqual(["config", "apiKey"]);
  });

  it("preserves original order", () => {
    const specs: InputSpec[] = [
      { key: "secret", type: "secret", label: "S" },
      { key: "pub", type: "public", label: "P" },
      { key: "semi", type: "semi", label: "M" },
    ];
    expect(incompleteSpecs(specs, { pub: "x" }).map((s) => s.key)).toEqual(["secret", "semi"]);
  });

  it("returns empty when every spec is public and known (on-chain never needs credentials)", () => {
    const specs: InputSpec[] = [{ key: "addressOrXpub", type: "public", label: "Bitcoin address" }];
    expect(incompleteSpecs(specs, { addressOrXpub: "bc1q" })).toEqual([]);
  });

  it("returns empty for no specs", () => {
    expect(incompleteSpecs([])).toEqual([]);
  });
});
