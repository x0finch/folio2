import { describe, expect, it } from "vitest";
import { parseFuturesAccount } from "../../../src/connectors/binance/parse";
import expected from "./fixtures/expected-futures-balances.json";
import account from "./fixtures/futures-account.json";

// 录制的 fapi /fapi/v2/account 响应 → 期望的 perp_equity + perp_position。覆盖:权益映射、
// 持仓方向/名义/杠杆/leverageType、强平价 null(不在 account 响应)、零仓位跳过、净值不变量。
describe("parseFuturesAccount (golden: fixture in → fixture out)", () => {
  const balances = parseFuturesAccount(account);

  it("maps fapi account → perp_equity + perp_position(强平价 null、零仓位跳过)", () => {
    expect(balances).toEqual(expected);
  });

  it("净值不变量:Σ value === 账户权益(权益行带值、仓位行 value:0,不双算)", () => {
    const total = balances.reduce((s, b) => s + b.value, 0);
    expect(total).toBe(12500.5);
  });

  it("零仓位(BNBUSDT positionAmt=0)被跳过", () => {
    const coins = balances.filter((b) => b.kind === "perp_position").map((b) => b.symbol);
    expect(coins).toEqual(["BTC", "ETH"]);
  });

  it("空账户(无权益、无持仓)→ 空数组(没开合约的用户不冒空行)", () => {
    expect(parseFuturesAccount({ totalMarginBalance: "0", positions: [] })).toEqual([]);
  });
});
