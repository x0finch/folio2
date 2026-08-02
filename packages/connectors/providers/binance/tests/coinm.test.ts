import { describe, expect, it } from "vitest";
import { parseCoinmFuturesAccount } from "../src";
import account from "./fixtures/coinm-account.json";
import expected from "./fixtures/expected-coinm-balances.json";

// 币本位:per-asset 保证金(币计价),按行情折 USD 聚合成单权益行 + 持仓行。价表用整数价 × 二进制精确
// 的小数量,乘积精确(避免浮点误差)。覆盖:多币折算聚合、notional/盈亏折 USD、张数 amount、零仓位跳过。
const PRICES = { BTCUSDT: 60000, ETHUSDT: 3000 };

describe("parseCoinmFuturesAccount (golden: fixture + prices in → fixture out)", () => {
  const balances = parseCoinmFuturesAccount(account, PRICES);

  it("各币 marginBalance/notional/盈亏折 USD,聚合成单权益行 + 持仓行", () => {
    expect(balances).toEqual(expected);
  });

  it("净值不变量:Σ value === 折 USD 总权益(持仓 value:0,不双算)", () => {
    expect(balances.reduce((s, b) => s + b.value, 0)).toBe(18000);
  });

  it("认不出价的币折 0(该币权益暂计 0)", () => {
    const noPrice = parseCoinmFuturesAccount(
      { assets: [{ asset: "XYZ", marginBalance: "5" }], positions: [] },
      {},
    );
    expect(noPrice).toEqual([]); // XYZ 无价 → equity 0 → 空账户
  });

  it("空账户 → 空数组", () => {
    expect(parseCoinmFuturesAccount({ assets: [], positions: [] }, PRICES)).toEqual([]);
  });
});
