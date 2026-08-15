import { describe, expect, it } from "vitest";
import { attachAccountGains } from "../src/routes/_authed/-accounts/attach-gains";

// #493 票 3:盈亏是另一包数据,客户端按账户 id / 余额行 id 拼回。拼错的后果是静默的
// (行上没有增量),所以钉子钉在拼法上,不钉数字怎么算。

const btcGain = { amount: 10, pct: 1, segments: [] };

const row = (over: Partial<Parameters<typeof attachAccountGains>[0][number]> = {}) => ({
  id: "a1",
  archivedAt: null as number | null,
  needsCredentials: false,
  balances: [{ id: "b1", tokenId: "tok-btc" }],
  ...over,
});

describe("attachAccountGains", () => {
  it("没到之前不贴字段 —— 加载中跟「算不出」不是一回事", () => {
    const out = attachAccountGains([row()], undefined, false);
    expect(out[0]).not.toHaveProperty("gain24h");
    expect(out[0].balances[0]).not.toHaveProperty("gain24h");
  });

  it("按账户 id 与余额行 id 贴回去;载荷里没有的键是算不出,不是省略", () => {
    const rows = [row(), row({ id: "a2", balances: [{ id: "b2", tokenId: "tok-eth" }] })];
    const out = attachAccountGains(
      rows,
      { accounts: { a1: btcGain }, balances: { b1: btcGain } },
      false,
    );
    expect(out[0].gain24h).toEqual(btcGain);
    expect(out[0].balances[0].gain24h).toEqual(btcGain);
    expect(out[1].gain24h).toBeNull();
    expect(out[1].balances[0].gain24h).toBeNull();
  });

  it("失败 → 活跃行都是算不出", () => {
    const out = attachAccountGains([row()], undefined, true);
    expect(out[0].gain24h).toBeNull();
    expect(out[0].balances[0].gain24h).toBeNull();
  });

  it("归档行不贴 —— 不该有这个数,整行省略,不是画破折号", () => {
    const out = attachAccountGains(
      [row({ archivedAt: 1 })],
      { accounts: { a1: btcGain }, balances: { b1: btcGain } },
      false,
    );
    expect(out[0].gain24h).toBeUndefined();
    expect(out[0].balances[0].gain24h).toBeUndefined();
  });

  it("缺凭据账户头不贴,现货行仍贴", () => {
    const out = attachAccountGains(
      [row({ needsCredentials: true })],
      { accounts: { a1: btcGain }, balances: { b1: btcGain } },
      false,
    );
    expect(out[0].gain24h).toBeUndefined();
    expect(out[0].balances[0].gain24h).toEqual(btcGain);
  });
});
