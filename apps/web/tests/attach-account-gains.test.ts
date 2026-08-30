import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { attachAccountHoldingGains, GAIN_WINDOW_MS, type PrevSlice } from "@/lib/core/portfolio";

// 账户抽屉逐币盈亏(ADR 0050,两端相减)。分档与组合级同一套(`classifyGain`):
//   · `prev` 两端相减;· `new`(今天新建/充值,起点空但当下快照在 24h 内)起点 0 → 现值全算进;
//   · `stale`(起点空且当下也 ≥24h 旧 = 断线超 7 天)→ `—`(null)。
// 现值侧与起点侧**同口径**(只 isFungible 现货、有 token_id 的行);非同质行(defi/perp)逐行盈亏
// 省略(各自分区给)。

const NOW = 1_700_000_000_000;
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

// 现货 + DeFi 各一行、同 token_id 的账户行。`takenAt` 决定起点空时的分档。
const mixedRow = (takenAt: number | null, totalUsd: number) => ({
  account: { id: "a" },
  archivedAt: null as number | null,
  takenAt,
  totalUsd,
  balances: [
    { id: "spot", tokenId: "shared", amount: 1, usdValue: 110, kind: "spot" },
    { id: "defi", tokenId: "shared", amount: 1, usdValue: 500, kind: "defi", metaJson: LIDO },
  ],
});

describe("attachAccountHoldingGains", () => {
  it("prev:同一 token_id 又有现货又有 DeFi 行 → 现货行盈亏只按现货两端算,不被 DeFi 虚高", () => {
    const prev = prevOf("a", [
      pb({ tokenId: "shared", usdValue: 100, kind: "spot" }),
      pb({ tokenId: "shared", usdValue: 480, kind: "defi", metaJson: LIDO }),
    ]);

    const [out] = attachAccountHoldingGains([mixedRow(NOW, 610)], prev, NOW);

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

  // FOL-51 用户裁定(推翻 FOL-43 原「账户不满 24h 显 —」):账户级 `new` 也把现值全算进(视同充值)。
  it("new:起点空但当下快照在 24h 内(今天新建/充值)→ 起点 0,现值全算进,pct null", () => {
    const [out] = attachAccountHoldingGains([mixedRow(NOW, 110)], new Map(), NOW);
    // 账户级:起点 0 → 全部余额算成今天赚的(现货 110)。pct null(分母 0)。
    expect(out!.gain24h?.amount).toBeCloseTo(110, 6);
    expect(out!.gain24h?.pct).toBeNull();
    // 现货行:起点 0 → +110。
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(110, 6);
    expect(spot?.gain24h?.pct).toBeNull();
    // DeFi 行仍省略。
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("stale:起点空且当下快照也 ≥24h 旧(断线超 7 天)→ 现货行 null(—)、非现货行 undefined", () => {
    const stale = NOW - GAIN_WINDOW_MS - 60_000;
    const [out] = attachAccountHoldingGains([mixedRow(stale, 110)], new Map(), NOW);
    expect(out!.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("归档账户 → 两级都省略(undefined)", () => {
    const row = { ...mixedRow(NOW, 110), archivedAt: NOW };
    const [out] = attachAccountHoldingGains([row], new Map(), NOW);
    expect(out!.gain24h).toBeUndefined();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeUndefined();
  });
});
