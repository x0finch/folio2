import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokens } from "@/lib/server/tokens/list";
import { handleGetTokenPrice, TokenPriceInput } from "@/lib/server/tokens/price";
import { countRows } from "../_kit/db";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// #527 · getTokenPrice
//
// 票是从搜索结果里拿的 —— 这与用户的真实路径一致(先搜、再点、才取价),也避免自己伪造一张
// 编码格式可能已经变了的票。
const USER = "h-tok-price";

const SEARCH = { coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }] };
const PRICE = { bitcoin: { usd: 50_000, usd_24h_change: 2.5, last_updated_at: 1_700_000_000 } };

const ticketOfBtc = async () => {
  stubOutbound([["/search", () => json(SEARCH)]]);
  const [first] = await call(USER, handleListTokens({ query: `btc-${crypto.randomUUID()}` }));
  return first.ticket;
};

beforeEach(async () => {
  await freshUser(USER);
});

describe("getTokenPrice", () => {
  it("传一张已知代币的票 → 拿到单价、涨跌与取到的时刻", async () => {
    const ticket = await ticketOfBtc();
    stubOutbound([["/simple/price", () => json(PRICE)]]);

    const out = await call(USER, handleGetTokenPrice({ ticket }));

    expect(out?.unitPrice).toBe(50_000);
    expect(out?.change24h).toBeCloseTo(2.5, 6);
    expect(out?.asOf).toBeTruthy();
  });

  it("上游没这个币的价 → 返回 null,不是 0", async () => {
    // 0 会被界面读成「这个币不值钱」,而事实是「我们不知道」。
    const ticket = await ticketOfBtc();
    stubOutbound([["/simple/price", () => json({})]]);

    expect(await call(USER, handleGetTokenPrice({ ticket }))).toBeNull();
  });

  it("点中不建行 —— 取价不许在库里落代币行", async () => {
    const ticket = await ticketOfBtc();
    stubOutbound([["/simple/price", () => json(PRICE)]]);
    const before = await countRows("tokens", USER);

    await call(USER, handleGetTokenPrice({ ticket }));

    expect(await countRows("tokens", USER)).toBe(before);
  });

  it("票是伪造的 / 解不开 → 不拿它去打上游", async () => {
    const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

    const out = await call(USER, handleGetTokenPrice({ ticket: "这不是一张票" })).catch(() => null);

    expect(out).toBeNull();
    expect(outbound.calls).toEqual([]);
  });

  it("ticket 空串 → schema 拒", () => {
    expect(TokenPriceInput.safeParse({ ticket: "" }).success).toBe(false);
  });
});
