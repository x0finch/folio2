import { describe, expect, it } from "vitest";
import { manualTokensJson } from "@/components/manual-tokens";

// First-token scalars of the manual add form -> single-element creds.tokens JSON. Numbers stay
// strings (the provider validator coerces them); empty ticket omits the key.
describe("manualTokensJson", () => {
  it("serializes one token, numbers left as strings", () => {
    expect(
      manualTokensJson({ symbol: "ETH", unitPrice: "3200", amount: "2", ticket: "tkt-eth" }),
    ).toBe('[{"symbol":"ETH","unitPrice":"3200","amount":"2","ticket":"tkt-eth"}]');
  });

  it("omits ticket when empty (manualToken treats it as optional)", () => {
    const out = JSON.parse(manualTokensJson({ symbol: "FOO", unitPrice: "0.25", amount: "1000" }));
    expect(out).toEqual([{ symbol: "FOO", unitPrice: "0.25", amount: "1000" }]);
    expect("ticket" in out[0]).toBe(false);
  });

  it("omits ticket when blank string", () => {
    const out = JSON.parse(
      manualTokensJson({ symbol: "BTC", unitPrice: "64000", amount: "0.5", ticket: "" }),
    );
    expect("ticket" in out[0]).toBe(false);
  });
});
