import { describe, expect, it } from "vitest";
import type { DefiGroup } from "../src/lib/core/account-view";
import { defiGainKey } from "../src/lib/core/account-view";
import {
  attachDefiGains,
  attachHoldingGains,
} from "../src/routes/_authed/-home/holdings/attach-gains";

// #488 票 5:盈亏是另一包数据,客户端按 key 拼回总览行。拼错的后果是静默的
// (行上破折号 / hero 那个数对不上),所以钉子钉在拼法上,不钉数字怎么算。

const btcGain = { amount: 10, pct: 1, segments: [] };
const aaveGain = { amount: 3, pct: 2, grossBasis: 100 };

describe("attachHoldingGains", () => {
  const rows: { key: string; gain24h?: typeof btcGain | null }[] = [{ key: "btc" }, { key: "eth" }];

  it("没到之前不贴字段 —— 加载中跟「算不出」不是一回事", () => {
    const out = attachHoldingGains(rows, undefined, false);
    expect(out[0]).not.toHaveProperty("gain24h");
    expect(out[1]).not.toHaveProperty("gain24h");
  });

  it("按 holding.key 贴回去;载荷里没有的键是算不出,不是省略", () => {
    const out = attachHoldingGains(rows, { holdings: { btc: btcGain }, defi: {} }, false);
    expect(out[0].gain24h).toEqual(btcGain);
    expect(out[1].gain24h).toBeNull();
  });

  it("失败 → 各行都是算不出", () => {
    const out = attachHoldingGains(rows, undefined, true);
    expect(out.map((h) => h.gain24h)).toEqual([null, null]);
  });
});

describe("attachDefiGains", () => {
  const sections: { account: { id: string }; defi: DefiGroup[] }[] = [
    { account: { id: "acc-1" }, defi: [{ protocol: "aave", rows: [] }] },
    { account: { id: "acc-2" }, defi: [{ protocol: "aave", rows: [] }] },
  ];

  it("没到之前不贴字段", () => {
    const out = attachDefiGains(sections, undefined, false);
    expect(out[0].defi[0]).not.toHaveProperty("gain24h");
  });

  it("键是账户 × 协议,跟服务端 defiGainKey 同形", () => {
    const out = attachDefiGains(
      sections,
      { holdings: {}, defi: { [defiGainKey("acc-1", "aave")]: aaveGain } },
      false,
    );
    expect(out[0].defi[0].gain24h).toEqual(aaveGain);
    expect(out[1].defi[0].gain24h).toBeNull();
  });
});
