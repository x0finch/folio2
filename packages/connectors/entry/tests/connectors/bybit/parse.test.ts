import { describe, expect, it } from "vitest";
import {
  buildPriceHint,
  parseEarn,
  parseFunding,
  parseUnified,
} from "../../../src/connectors/bybit/parse";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnOnchain from "./fixtures/earn-onchain.json";
import expectedFlexible from "./fixtures/expected-flexible-earn.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedOnchain from "./fixtures/expected-onchain-earn.json";
import expectedUnified from "./fixtures/expected-unified-balances.json";
import funding from "./fixtures/funding.json";
import walletBalance from "./fixtures/wallet-balance.json";

// 两份 fixture 一一对应:wallet-balance.json(录制的 /v5/account/wallet-balance UNIFIED 响应)→
// expected-unified-balances.json。覆盖:walletBalance→amount(不含 uPnL,不用 equity)、usdValue→value
// (自带估值)、price=usdValue/amount、跳过 walletBalance≤0(DUST)、locked→Locked note。
describe("parseUnified (golden: fixture in → fixture out)", () => {
  const coins = walletBalance.result.list[0].coin;

  it("maps recorded UNIFIED coins to expected-unified-balances", () => {
    expect(parseUnified(coins)).toEqual(expectedUnified);
  });

  it("持有量取 walletBalance 而非 equity —— 合约浮盈不混进现货(ADR 0032)", () => {
    // BTC:walletBalance=0.05(现金),equity=0.06(含 0.01 浮盈)。取 walletBalance → amount=0.05;
    // 误用 equity 会把没落袋的浮盈算成现货持有。
    const btc = parseUnified(coins).find((b) => b.symbol === "BTC");
    expect(btc).toMatchObject({ amount: 0.05, value: 3000 });
  });

  it("value 用 Bybit 自带 usdValue,price 反推;locked 的币挂 Locked note", () => {
    const rows = parseUnified(coins);
    expect(rows.find((b) => b.symbol === "USD1")?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "80,000 USD1 · 100%",
    });
    expect(rows.find((b) => b.symbol === "USDT")?.note).toBeUndefined();
  });

  it("跳过 walletBalance≤0 的尘埃(DUST)", () => {
    expect(parseUnified(coins).some((b) => b.symbol === "DUST")).toBe(false);
  });
});

// 资金账户(FUND)golden:funding.json(录制的 /asset/transfer/query-account-coins-balance 响应)+
// 统一账户市价提示表 → expected-funding-balances.json。覆盖:walletBalance→amount、稳定币≈1(USDT)、
// 统一账户市价复用(BTC)、无价的币 value 0 交 oracle(WLFI)、每条带 note.group:"funding"。
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(walletBalance.result.list[0].coin);
    expect(parseFunding(funding.result.balance, hint)).toEqual(expectedFunding);
  });

  it("每条 funding 余额带不渲染的 note.group='funding'(供抽屉归 Tab)", () => {
    const hint = buildPriceHint(walletBalance.result.list[0].coin);
    expect(
      parseFunding(funding.result.balance, hint).every((r) => r.note?.group === "funding"),
    ).toBe(true);
  });
});

// 赚币(earn)golden:earn-flexible/onchain.json + 统一账户市价提示表 → 期望值。覆盖:amount→amount、
// 类目标签(Flexible / On-chain)、note.group:"earn"、价复用统一账户市价(BTC)/稳定币(USDT)、
// 跳过 amount≤0(已赎回残值)。**不标 APY**(Bybit 持仓端点无 APR,ADR 0032)。
describe("parseEarn (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(walletBalance.result.list[0].coin);
  it("flexible: amount→amount, 类目 note content='Flexible', group earn;跳过 amount=0", () => {
    expect(parseEarn(earnFlexible.result.list, "Flexible", hint)).toEqual(expectedFlexible);
  });
  it("on-chain: 类目 note content='On-chain', group earn", () => {
    expect(parseEarn(earnOnchain.result.list, "On-chain", hint)).toEqual(expectedOnchain);
  });
});
