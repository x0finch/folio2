import { describe, expect, it } from "vitest";
import { parseEarnPositions } from "../src";
import flexible from "./fixtures/earn-flexible.json";
import locked from "./fixtures/earn-locked.json";
import expected from "./fixtures/expected-earn-balances.json";

// 理财当 spot + balance 级 note:活期 → "Flexible · X% APY";定期 → "Locked until MM/DD · X% APY"(info)。
// ticker 估值(同现货),零余额跳过,锁定的币照常计入净值。redeemDate 用固定 ms → 稳定 MM/DD。
const PRICES = { BTCUSDT: 60000 };

describe("parseEarnPositions (golden)", () => {
  it("活期 + 定期 → spot + APY/锁定 note(info 语气),ticker 估值,零余额跳过", () => {
    expect(parseEarnPositions(flexible, locked, PRICES)).toEqual(expected);
  });

  it("空理财 → 空数组", () => {
    expect(parseEarnPositions({ rows: [] }, { rows: [] }, PRICES)).toEqual([]);
  });
});
