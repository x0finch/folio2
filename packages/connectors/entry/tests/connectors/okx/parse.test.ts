import { describe, expect, it } from "vitest";
import {
  buildPriceHint,
  earnResidualRow,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
} from "../../../src/connectors/okx/parse";
import balance from "./fixtures/balance.json";
import expected from "./fixtures/expected-balances.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedSavings from "./fixtures/expected-savings-balances.json";
import expectedStaking from "./fixtures/expected-staking-balances.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";

// 两份 fixture 一一对应:balance.json(录制的 /api/v5/account/balance 响应)→
// expected-balances.json(解析后的期望值)。覆盖:cashBal→amount(修 #259,不含 uPnL)、
// price=eqUsd/eq(市价)、value=amount×price、跳过零/空(DUST)。
// JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseBalances (golden: fixture in → fixture out)", () => {
  it("maps the recorded balance details to expected-balances", () => {
    // per-balance note(note 重设计,单个 Note):ETH frozenBal=0.5 → 它自己那笔挂 Frozen note;其余无 note。
    expect(parseBalances(balance.data[0].details)).toEqual(expected);
  });

  it("持有量取 cashBal 而非 eq —— 合约浮盈(uPnL)不混进现货(修 #259)", () => {
    // USDT 作合约保证金:eq=1200(含 200 浮盈),cashBal=1000(真实现金)。取 cashBal → amount=1000;
    // 价格走 eqUsd/eq=1(与 uPnL 无关),value=1000。若误用 eq,USDT 会虚增成 1200。
    const usdt = parseBalances(balance.data[0].details).find((b) => b.symbol === "USDT");
    expect(usdt).toMatchObject({ amount: 1000, price: 1, value: 1000 });
  });

  it("质押凭证币(OKSOL)只从交易账户算一次,不被质押端点重复计(不双算)", () => {
    // OKSOL 作为币已躺在交易账户 details 里(cashBal=10)。本片不打质押端点 → 它只出现一次。
    const rows = parseBalances(balance.data[0].details);
    expect(rows.filter((b) => b.symbol === "OKSOL")).toHaveLength(1);
    expect(rows.find((b) => b.symbol === "OKSOL")).toMatchObject({ amount: 10, value: 700 });
  });

  it("冻结的币(ETH)自带 Frozen note;无冻结的币(BTC/USDT)无 note", () => {
    const rows = parseBalances(balance.data[0].details);
    expect(rows.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Frozen",
      icon: "warning",
      content: "0.5 ETH · 25%",
    });
    expect(rows.find((b) => b.symbol === "BTC")?.note).toBeUndefined();
    expect(rows.find((b) => b.symbol === "USDT")?.note).toBeUndefined();
  });
});

// 资金账户(funding 桶)golden:funding.json(录制的 /asset/balances 响应)+ 交易账户市价提示表
// → expected-funding-balances.json。覆盖:bal→amount、稳定币≈1(USDT)、交易账户市价复用(BTC)、
// 无价的币 value 0 交 oracle(PEPE)、每条带 note.group:"funding"。
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(balance.data[0].details);
    expect(parseFunding(funding.data, hint)).toEqual(expectedFunding);
  });

  it("每条 funding 余额带不渲染的 note.group='funding'(供抽屉归 Tab)", () => {
    const hint = buildPriceHint(balance.data[0].details);
    const rows = parseFunding(funding.data, hint);
    expect(rows.every((r) => r.note?.group === "funding")).toBe(true);
  });
});

// 赚币(earn 桶)golden:savings/staking 响应 + 市价提示表 → 期望值。覆盖:amt→amount、rate/apy→APY note、
// note.group:"earn"、价复用交易账户市价(ETH)/稳定币(USDT)。
describe("parseSavings / parseStaking (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(balance.data[0].details);
  it("savings: amt→amount, rate→'Flexible · X% APY' note, group earn", () => {
    expect(parseSavings(savings.data, hint)).toEqual(expectedSavings);
  });
  it("staking: investData[].amt→amount, protocol+apy note, group earn", () => {
    expect(parseStaking(staking.data, hint)).toEqual(expectedStaking);
  });
});

// earn 残差 → 计进净值的合成聚合行:拉到的 earn 子项加总 vs asset-valuation 的 earn 桶。
describe("earnResidualRow", () => {
  const hint = buildPriceHint(balance.data[0].details);
  const earnItems = [...parseSavings(savings.data, hint), ...parseStaking(staking.data, hint)];

  it("earn 桶 > 拉到的加总 → 产一条 value=残差 的合成行(计进净值),带中性 note", () => {
    // earn 桶 12000;拉到 USDT 5000 + ETH 6000 = 11000;残差 1000。
    const row = earnResidualRow(12000, earnItems, hint);
    expect(row).toMatchObject({
      kind: "spot",
      value: 1000,
      symbol: "USD", // 数字是美元估值 → 单位 USD(非某个币的枚数)
      name: "OKX Earn (Uncategorized)",
      tokenRef: "okx/custom:EARN-UNCATEGORIZED",
    });
    expect(row?.logo).toMatch(/^data:image\/svg\+xml/); // 内嵌 OKX 标(走 tokenLogoUrl data: 直挂)
    expect(row?.note?.group).toBe("earn");
    expect(String(row?.note?.content)).toContain("$1,000");
  });

  it("earn 桶 ≈ 拉到的加总(差额 ≤ 阈值)→ 不产行", () => {
    expect(earnResidualRow(11000, earnItems, hint)).toBeUndefined();
  });

  it("有 earn 子项估不出价(残差不可信)→ 不产行(不拿脏数污染净值)", () => {
    // 追加一个无提示价、非稳定币的 earn 项 → unpriced>0 → 抑制。
    const withUnpriced = [
      ...earnItems,
      { symbol: "XYZ", amount: 1, value: 0, kind: "spot", tokenRef: "okx/issued:XYZ" } as const,
    ];
    expect(earnResidualRow(99999, withUnpriced, hint)).toBeUndefined();
  });
});
