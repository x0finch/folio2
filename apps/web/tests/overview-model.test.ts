import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Platforms } from "@folio/platforms";
import type { Tokens } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { buildOverview } from "../src/lib/overview-model";

// 纯 buildOverview 可脱离 server fn 测(依赖注入)—— 这是 #3 抽读模型的收益。
// 用假 tokens/platforms + 最小 fixture,覆盖:eligible 过滤 → enrich 附回 → 聚合 → 平台装饰 → 总额。

const account = (id: string, label: string, type = "onchain_evm", network: string | null = null) =>
  ({ id, label, type, network, archivedAt: null }) as unknown as AccountSafe;

const bal = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "USDC",
  amount: 0,
  usdValue: 0,
  kind: "spot",
  metaJson: null,
  ...over,
});

const snap = (accountId: string, totalUsd: number, balances: OverviewBalance[]) =>
  ({
    snapshot: { accountId, totalUsd, takenAt: 1000 },
    balances,
  }) as unknown as SnapshotWithBalances;

// 假 tokens:每个 asset 都解析成 usdc 组(证明 enrich 结果被正确附回并进聚合)。
const tokens = {
  async enrich(assets: { symbol: string; tokenKey?: string }[]) {
    return assets.map(() => ({
      ref: { source: "coingecko", identifier: "usd-coin" },
      group: { id: "usdc", displaySymbol: "USDC", name: "USD Coin" },
      name: "USD Coin",
      logo: "u.png",
      priceStale: false,
    }));
  },
} as unknown as Tokens;

// 假 platforms:每个 key 回 "NAME:<key>",验证读路径装饰确实覆写了 aggregate 的占位名。
const platforms = {
  async resolve(keys: string[]) {
    return new Map(keys.map((k) => [k, { key: k, name: `NAME:${k}`, logo: undefined }]));
  },
} as unknown as Platforms;

describe("buildOverview", () => {
  it("跨账户聚合成一个 Holding + 平台装饰 + 总额", async () => {
    const accounts = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const byAccount = new Map([
      [
        "a1",
        snap("a1", 100, [
          bal({ tokenKey: "eip155:42161/erc20:0xusdc", amount: 100, usdValue: 100 }),
        ]),
      ],
      [
        "a2",
        snap("a2", 50, [
          bal({ kind: "manual", tokenKey: "coingecko:usd-coin", amount: 50, usdValue: 50 }),
        ]),
      ],
    ]);

    const view = await buildOverview(accounts, byAccount, { tokens, platforms });

    // 两笔 USDC(不同账户/平台)并成一条 Holding。
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].token.symbol).toBe("USDC");
    expect(view.holdings[0].totalValue).toBe(150);
    expect(view.holdings[0].sources).toHaveLength(2);

    // 平台名由 platforms.resolve 装饰(覆写 aggregate 的 key 占位):链前缀 + manual。
    expect(view.holdings[0].sources.map((s) => s.platform.name).sort()).toEqual([
      "NAME:eip155:42161",
      "NAME:manual",
    ]);

    expect(view.totalUsd).toBe(150);
    expect(view.holdingsSubtotal).toBe(150);
    expect(view.pricesStale).toBe(false);
    expect(view.sections).toHaveLength(0); // 无 defi/perp
  });

  it("非 eligible(defi)不进 Holdings,进次级分区", async () => {
    const accounts = [account("a1", "Arb")];
    const byAccount = new Map([
      [
        "a1",
        snap("a1", 100, [
          bal({
            symbol: "USDC",
            kind: "spot",
            amount: 100,
            usdValue: 100,
            tokenKey: "coingecko:usd-coin",
          }),
          bal({
            symbol: "aUSDC",
            kind: "defi",
            amount: 10,
            usdValue: 10,
            metaJson: '{"protocol":"aave"}',
          }),
        ]),
      ],
    ]);

    const view = await buildOverview(accounts, byAccount, { tokens, platforms });

    expect(view.holdings).toHaveLength(1); // 只 spot USDC
    expect(view.holdings[0].totalValue).toBe(100);
    expect(view.sections).toHaveLength(1); // defi 进次级分区
    expect(view.defiSubtotal).toBe(10);
  });
});
