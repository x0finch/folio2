import type { Balance } from "@folio/connectors-basic";
import type { Tokens } from "@folio/oracle2";
import { describe, expect, it } from "vitest";
import { revalue } from "../src/lib/revalue";

// **本文件只测估值,不测认币。** #202 之前 revalue 自己调 `tokens.resolve` 解析身份,所以这里曾经
// 搭着一整套假 store + 假 source,还顺带测「按 symbol 认得出 BTC」之类 —— 那些断言现在归
// `packages/oracle2/entry/tests/mint.test.ts`。revalue 只剩两件事:按 mode 定 value、捕获 selfPrice。
//
// 于是假件也塌成一个 `priceOf`。**记调用次数**:「有自带价就不回源」是一条性能承诺
//(self-first 下 CEX 不该为每个币问一次价),不数次数就测不到。
function fakeTokens(prices: Record<string, number>) {
  const asked: string[] = [];
  const tokens = {
    async priceOf(tokenId: string) {
      asked.push(tokenId);
      const unitPrice = prices[tokenId];
      return unitPrice === undefined ? undefined : { unitPrice, asOf: 0, stale: false };
    },
    // revalue 只碰 priceOf;其余能力在本文件里够不着,不搭。
  } as unknown as Tokens;
  return { tokens, asked };
}

const PRICES = { tk_btc: 65000, tk_ton: 5 };
// mint 那一步的产物:tokenRef → token_id。认不出来的 ref 不在里面。
const IDS = new Map([
  ["bitcoin/native", "tk_btc"],
  ["binance/BTC", "tk_btc"],
  ["coingecko/bitcoin", "tk_btc"],
  ["coingecko/the-open-network", "tk_ton"],
  // 认得出但上游没价 —— 与「压根认不出」是两种情况,都该回退自带价。
  ["binance/PRIVATETOKEN", "tk_private"],
]);

const spot = (over: Partial<Balance> & Pick<Balance, "symbol" | "amount" | "value">): Balance =>
  ({ kind: "spot", ...over }) as Balance;

describe("revalue —— 盯市类型(无权威自带价,恒用源价)", () => {
  it("认得出 → value = 数量 × 市价", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      true,
      [spot({ symbol: "BTC", amount: 0.5, value: 1, tokenRef: "coingecko/bitcoin" })],
      IDS,
    );
    expect(out[0].value).toBe(32500); // 0.5 × 65000
  });

  it("bitcoin:provider 只给 amount(value=0)→ 按市价算出来", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      true,
      [spot({ symbol: "BTC", amount: 0.08, value: 0, tokenRef: "bitcoin/native" })],
      IDS,
    );
    expect(out[0].value).toBe(5200); // 0.08 × 65000
  });

  // mint 没认出来 → 这里**不猜**(以前会掉回 symbol 解析,那条路已经堵了,见 ADR 0020 第三轮)。
  it("mint 没给出 id → 保留 provider 原值,且一次都不问价", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      true,
      [spot({ symbol: "PRIVATETOKEN", amount: 10, value: 99, tokenRef: "manual/PRIVATETOKEN" })],
      IDS,
    );
    expect(out[0].value).toBe(99);
    expect(asked).toEqual([]);
  });

  it("压根没有 tokenRef(导入的旧行)→ 同样保留原值、不问价", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await revalue(tokens, true, [spot({ symbol: "FOO", amount: 1, value: 7 })], IDS);
    expect(out[0].value).toBe(7);
    expect(asked).toEqual([]);
  });
});

describe("revalue —— 非盯市类型(有权威自带价)", () => {
  it("self-first:捕获 selfPrice、value 不变、**不回源**", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      false,
      [spot({ symbol: "BTC", amount: 2, value: 120000, tokenRef: "binance/BTC" })],
      IDS,
    );
    expect(out[0].value).toBe(120000); // 自带价权威,不动
    expect(out[0].selfPrice).toBe(60000); // 120000 / 2,捕获为原料
    expect(asked).toEqual([]); // 与旧行为同开销:CEX 有自带价即不问价
  });

  it("source-first:改用源价,selfPrice 仍留存(可切回)", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      false,
      [spot({ symbol: "BTC", amount: 2, value: 120000, tokenRef: "binance/BTC" })],
      IDS,
      "source-first",
    );
    expect(out[0].value).toBe(130000); // 2 × 65000
    expect(out[0].price).toBe(65000);
    expect(out[0].selfPrice).toBe(60000);
  });

  it("source-first 但上游没这个币的价 → 回退自带价", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await revalue(
      tokens,
      false,
      [spot({ symbol: "PRIVATETOKEN", amount: 10, value: 99, tokenRef: "binance/PRIVATETOKEN" })],
      IDS,
      "source-first",
    );
    expect(out[0].value).toBe(99);
    expect(out[0].selfPrice).toBe(9.9);
    expect(asked).toEqual(["tk_private"]); // 问过了,只是上游没有
  });
});

// —— 永续行不按市价重估(P5.1:仓位 value 恒 0、权益 = 账户净值;否则净值被名义敞口污染) ——
describe("revalue —— 永续行保留 provider value", () => {
  const perp = (kind: "perp_position" | "perp_equity", amount: number, value: number): Balance =>
    ({ symbol: "ETH", amount, value, kind, tokenRef: "hyperliquid/ETH" }) as unknown as Balance;

  it("perp_position value 恒 0(即便数量大、币认得出),不重估成 数量×币价", async () => {
    const { tokens, asked } = fakeTokens(PRICES);
    const out = await revalue(tokens, true, [perp("perp_position", -40391.56, 0)], IDS);
    expect(out[0].value).toBe(0);
    expect(asked).toEqual([]); // 连价都不问
  });

  it("perp_equity 保留账户净值,不按 数量×币价 覆写", async () => {
    const { tokens } = fakeTokens(PRICES);
    const out = await revalue(tokens, true, [perp("perp_equity", 34427709, 34425196)], IDS);
    expect(out[0].value).toBe(34425196);
  });
});
