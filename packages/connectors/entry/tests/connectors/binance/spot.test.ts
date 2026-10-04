import { describe, expect, it } from "vitest";
import { parseAccountBalances } from "../../../src/connectors/binance/parse";
import account from "./fixtures/account.json";
import expected from "./fixtures/expected-balances.json";
import prices from "./fixtures/prices.json";

// 两份 fixture 一一对应:account.json(录制的 /api/v3/account 响应)+ prices.json(行情价映射)
// → expected-balances.json(解析后的期望值)。覆盖:free+locked 合并、按价估值(稳定币≈1、
// 无交易对→0)、跳过零余额(BNB)。JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseAccountBalances (golden: fixtures in → fixture out)", () => {
  const balances = parseAccountBalances(account, prices);

  it("maps the recorded account + price map to expected-balances", () => {
    // per-balance note(note 重设计,单个 Note):ETH locked=1 → 它自己那笔挂 Locked note;其余无 note。
    expect(balances).toEqual(expected);
    // BNB has zero balance → excluded
    expect(balances.find((b) => b.symbol === "BNB")).toBeUndefined();
  });

  it("跳过 LD 前缀理财份额(LDBNB,与 earn wallet 重复),但保留 LDO 等短币真币", () => {
    const rows = parseAccountBalances(
      {
        balances: [
          { asset: "LDBNB", free: "1", locked: "0" },
          { asset: "LDO", free: "2", locked: "0" },
          { asset: "BTC", free: "0.5", locked: "0" },
        ],
      },
      { LDOUSDT: 10, BTCUSDT: 60000 },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["LDO", "BTC"]);
  });
});
