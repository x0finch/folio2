import { describe, expect, it } from "vitest";
import { parseFundingAssets } from "../src";
import expected from "./fixtures/expected-funding-balances.json";
import assets from "./fixtures/funding-assets.json";

// 资金账户当 spot:free+locked+freeze+withdrawing 合并为持有量,ticker 估值(同现货),零余额跳过。
const PRICES = { BTCUSDT: 60000 };

describe("parseFundingAssets (golden)", () => {
  it("合并各状态余额、ticker 估值、零余额(DUST)跳过", () => {
    expect(parseFundingAssets(assets, PRICES)).toEqual(expected);
  });

  it("无价的币 → value 0(price 省略)", () => {
    expect(parseFundingAssets([{ asset: "XYZ", free: "5" }], {})).toEqual([
      {
        symbol: "XYZ",
        amount: 5,
        value: 0,
        kind: "spot",
        tokenRef: "binance/issued:XYZ",
        note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
      },
    ]);
  });
});
