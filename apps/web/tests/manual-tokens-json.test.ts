import { describe, expect, it } from "vitest";
import { manualTokensJson } from "../src/lib/manual-tokens";

// manual 加账户表单首 token 标量 → 单元素 creds.tokens JSON(ADR 0017)。
// 数字保持字符串(交给 provider 的 manualToken validator coerce);ticket 空则省略键。
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
