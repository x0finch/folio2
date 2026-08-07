import { describe, expect, it } from "vitest";
import { parseClearinghouseState } from "../../../src/connectors/hyperliquid/parse";
import fixture from "./fixtures/clearinghouse-state.json";
import expected from "./fixtures/expected-balances.json";

// expected-balances.json(解析后的期望值,固化逐一对比)。覆盖:权益行 kind:"perp_equity"(唯一带值)
// + 每仓位一行 kind:"perp_position"(value=0、明细进 meta、无 role);字符串字段统一 Number();
// szi 符号→side(long/short);liquidationPx 可为 null。expected 是对旧 golden 的手工变换(改 kind + 删 role)。
describe("parseClearinghouseState (golden: fixture in → fixture out)", () => {
  it("maps the recorded response to expected-balances (kind-split, no role)", () => {
    expect(parseClearinghouseState(fixture)).toEqual(expected);
  });

  it("emits only the perp_equity row for an account with no open positions", () => {
    const balances = parseClearinghouseState({
      marginSummary: {
        accountValue: "0.0",
        totalMarginUsed: "0.0",
        totalNtlPos: "0.0",
        totalRawUsd: "0.0",
      },
      assetPositions: [],
      withdrawable: "0.0",
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ symbol: "USDC", amount: 0, value: 0, kind: "perp_equity" });
  });

  it("total value equals account equity (positions do not double-count)", () => {
    const total = parseClearinghouseState(fixture).reduce((s, b) => s + b.value, 0);
    expect(total).toBe(13109.482328);
  });
});
