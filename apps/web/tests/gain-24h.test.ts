import { describe, expect, it } from "vitest";
import {
  assembleGainStart,
  endpointGain,
  type StartSnapshot,
  tokenLineKey,
} from "@/lib/server/portfolio/gain-24h";

// 24h 盈亏的纯函数面(ADR 0050):**两端相减**,现在的值 − 24 小时前的值。
// 这里穷尽口径本身;「起点那张快照怎么取(≤ 24h 的最近一张)」在真 D1 上钉
// (`tests/server/portfolio/gain.cases.ts` —— at-or-before 是 SQL 的事)。

describe("endpointGain —— 两端相减", () => {
  it("正常情形:金额 = 差值,百分比分母 = 起点值", () => {
    expect(endpointGain(100, 130)).toEqual({ amount: 30, pct: 30 });
    expect(endpointGain(200, 150)).toEqual({ amount: -50, pct: -25 });
  });

  it("没有起点(账户不满 24 小时)→ null,不是 0 —— 两者界面上必须分得开", () => {
    expect(endpointGain(null, 130)).toBeNull();
    expect(endpointGain(undefined, 130)).toBeNull();
  });

  it("算得出、确实没涨没跌 → { 0, 0 },是一条真实结论", () => {
    expect(endpointGain(100, 100)).toEqual({ amount: 0, pct: 0 });
  });

  it("起点值 0 → 金额照给,百分比 null(没有分母)", () => {
    expect(endpointGain(0, 130)).toEqual({ amount: 130, pct: null });
  });

  it("起点值为负(DeFi 净负债)→ 百分比同样 null,金额照给", () => {
    expect(endpointGain(-50, -20)).toEqual({ amount: 30, pct: null });
  });

  it("窗口中途的充值**体现在盈亏里** —— 这是用户裁定的设计,不是 bug", () => {
    // 24h 前值 100;中午充进 50;现在 155(充的 50 + 涨的 5)。
    // 裁定口径就是 155 − 100 = 55:那 50 的本金**算在今天的盈亏里**,不做任何剔除。
    const gain = endpointGain(100, 155);
    expect(gain?.amount).toBe(55); // 不是 5 —— 充值在里面
    expect(gain?.pct).toBeCloseTo(55, 6);
  });

  it("服务停摆过 → 起点是手头最近那张(几天前),跨度更长但数字是真话", () => {
    // 起点的「多久以前」不进公式 —— 两端相减对任何跨度都成立,没有特殊规则;
    // 下一张整点快照落下,窗口自己校正回 24 小时。
    expect(endpointGain(80, 130)).toEqual({ amount: 50, pct: 62.5 });
  });
});

describe("assembleGainStart —— 起点观测的汇总", () => {
  const snap = (
    accountId: string,
    totalUsd: number,
    balances: StartSnapshot["balances"],
  ): StartSnapshot => ({ accountId, takenAt: 0, totalUsd, balances });

  it("一个账户都没有起点 → total 是 null:什么都算不出", () => {
    const start = assembleGainStart([]);
    expect(start.total).toBeNull();
    expect(start.accounts.size).toBe(0);
  });

  it("按账户 / 币 / (账户 × 币) 各汇总一份,total = 各账户总额相加", () => {
    const start = assembleGainStart([
      snap("a1", 150, [
        { tokenId: "btc", usdValue: 100, kind: "spot" },
        { tokenId: "eth", usdValue: 50, kind: "spot" },
      ]),
      snap("a2", 30, [{ tokenId: "btc", usdValue: 30, kind: "spot" }]),
    ]);
    expect(start.total).toBe(180);
    expect(start.accounts.get("a1")).toBe(150);
    expect(start.tokens.get("btc")).toBe(130); // 跨账户合并
    expect(start.tokensByAccount.get(tokenLineKey("a2", "btc"))).toBe(30);
  });

  it("没有起点的账户不出现在 accounts 里 —— 「查不到」就是那个账户的 null", () => {
    const start = assembleGainStart([snap("old", 100, [])]);
    expect(start.accounts.has("fresh")).toBe(false); // 消费方据此给 null
    expect(start.accounts.get("old")).toBe(100);
  });

  it("币的合计只认现货口径(isFungible)—— perp 权益不进代币行,与总览聚合对齐", () => {
    const start = assembleGainStart([
      snap("a1", 300, [
        { tokenId: "btc", usdValue: 100, kind: "spot" },
        { tokenId: "usdc", usdValue: 200, kind: "perp_equity" },
      ]),
    ]);
    expect(start.tokens.get("btc")).toBe(100);
    expect(start.tokens.has("usdc")).toBe(false);
    expect(start.total).toBe(300); // 账户总额照旧包含它
  });

  it("DeFi 腿按 (账户 × 协议) 汇成**净值**(带符号相加),不进代币行", () => {
    const start = assembleGainStart([
      snap("a1", 100, [
        {
          tokenId: "btc",
          usdValue: 300,
          kind: "defi",
          metaJson: JSON.stringify({ protocol: "aave" }),
        },
        {
          tokenId: "eth",
          usdValue: -200,
          kind: "defi",
          metaJson: JSON.stringify({ protocol: "aave" }),
        },
      ]),
    ]);
    expect(start.defi.get("a1|aave")).toBe(100); // 净值,不是 |300| + |−200|
    expect(start.tokens.size).toBe(0);
  });

  it("metaJson 坏了 / 没写协议 → 归入兜底协议组,不炸", () => {
    const start = assembleGainStart([
      snap("a1", 10, [{ tokenId: "x", usdValue: 10, kind: "defi", metaJson: "{oops" }]),
    ]);
    expect(start.defi.get("a1|Other")).toBe(10);
  });

  it("无 token_id 的行(v2 导入)不进代币行,但账户总额照算", () => {
    const start = assembleGainStart([
      snap("a1", 42, [{ tokenId: null, usdValue: 42, kind: "spot" }]),
    ]);
    expect(start.tokens.size).toBe(0);
    expect(start.accounts.get("a1")).toBe(42);
  });
});
