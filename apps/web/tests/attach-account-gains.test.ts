import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { attachAccountHoldingGains, type PrevSlice } from "@/lib/core/portfolio";

// 账户抽屉逐币盈亏(ADR 0050,**最简两档**):
//   · 有基准(`prev != null`)→ 两端相减(账户级 + 逐现货行按市值占比摊分)。
//   · 无基准(新账户 / 新建 manual / 断线超 7 天)→ 一律 `null`(`—`),不硬算。
// 现值侧与起点侧**同口径**(只 isFungible 现货、有 token_id 的行);非同质行(defi/perp)逐行盈亏
// 省略(各自分区给)。

const LIDO = JSON.stringify({ protocol: "Lido", positionType: "staked" });

// 起点组的一行(OverviewBalance;viewKind 只读 kind/metaJson)。
const pb = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "S",
  amount: 1,
  usdValue: 0,
  kind: "spot",
  tokenId: "shared",
  metaJson: null,
  ...over,
});

const prevOf = (accountId: string, balances: OverviewBalance[]): ReadonlyMap<string, PrevSlice> =>
  new Map([[accountId, { snapshot: { takenAt: 0 }, balances }]]);

// 现货 + DeFi 各一行、同 token_id 的账户行。
const mixedRow = (totalUsd: number, archivedAt: number | null = null) => ({
  account: { id: "a" },
  archivedAt,
  totalUsd,
  balances: [
    { id: "spot", tokenId: "shared", amount: 1, usdValue: 110, kind: "spot" },
    { id: "defi", tokenId: "shared", amount: 1, usdValue: 500, kind: "defi", metaJson: LIDO },
  ],
});

describe("attachAccountHoldingGains", () => {
  it("有基准:同一 token_id 又有现货又有 DeFi 行 → 现货行盈亏只按现货两端算,不被 DeFi 虚高", () => {
    const prev = prevOf("a", [
      pb({ tokenId: "shared", usdValue: 100, kind: "spot" }),
      pb({ tokenId: "shared", usdValue: 480, kind: "defi", metaJson: LIDO }),
    ]);

    const [out] = attachAccountHoldingGains([mixedRow(610)], prev);

    // 账户级:全部余额两端相减 610 − 580 = +30。
    expect(out!.gain24h?.amount).toBeCloseTo(30, 6);
    // 现货行:起点 100(只现货)→ 现值 110(只现货,DeFi 那 500 不算进)→ +10。
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(10, 6);
    expect(spot?.gain24h?.pct).toBeCloseTo(10, 6);
    // 没修之前:现值会被算成 110+500=610,+510 摊到现货行 ≈ +91.8。钉住它不再发生。
    expect(spot?.gain24h?.amount).not.toBeCloseTo(91.8, 1);
    // DeFi 行不是现货 → 逐行盈亏字段省略(它的盈亏由 DeFi 分区给)。
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("有基准 + 账户 24h 前没这个币 → 起点 0,该币现值全算进(账户内今天新买)", () => {
    // 账户**有基准**(prev 非空,里头是别的币),只是这个 token 起点 0 —— 与「整个账户无基准」不同。
    const prev = prevOf("a", [pb({ tokenId: "other", usdValue: 50, kind: "spot" })]);
    const [out] = attachAccountHoldingGains([mixedRow(160)], prev);
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(110, 6); // 起点 0 → +现值
    expect(spot?.gain24h?.pct).toBeNull(); // 分母 0
  });

  // 最终两档:无基准(新账户 / 新建 manual / 断线超 7 天)一律 `—`,不硬算、不区分 new/stale。
  it("无基准(空起点组)→ 账户级 null、现货行 null(—)、非现货行 undefined", () => {
    const [out] = attachAccountHoldingGains([mixedRow(110)], new Map());
    expect(out!.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("归档账户 → 两级都省略(undefined)", () => {
    const [out] = attachAccountHoldingGains([mixedRow(110, 1)], new Map());
    expect(out!.gain24h).toBeUndefined();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeUndefined();
  });
});
