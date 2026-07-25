import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Platforms } from "@folio/oracle-basic";
import type { Tokens } from "@folio/tokens";
import { cgkRef } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { buildOverview } from "../src/lib/overview-model";

// 纯 buildOverview 可脱离 server fn 测(依赖注入)—— 这是 #3 抽读模型的收益。
// 用假 tokens/platforms + 最小 fixture,覆盖:eligible 过滤 → enrich 附回 → 聚合 → 平台装饰 → 总额。

const account = (id: string, label: string, connectorId = "evm", network: string | null = null) =>
  ({ id, label, connectorId, network, archivedAt: null }) as unknown as AccountSafe;

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
  async enrich(assets: { symbol: string; providerRef?: string }[]) {
    return assets.map(() => ({
      ref: cgkRef("usd-coin"),
      group: { id: "usdc", displaySymbol: "USDC", name: "USD Coin" },
      name: "USD Coin",
      logo: "u.png",
      priceStale: false,
    }));
  },
} as unknown as Tokens;

// 假 platforms:每个 key 回 "NAME:<key>";manual 无上游图(真实 resolve 对未收录/未 warm 的 key
// 不带 logo)。验证读路径装饰覆写占位名,并把有图的平台 logo 改写成代理 URL、无图的置 undefined。
const platforms = {
  async resolve(keys: string[]) {
    return new Map(
      keys.map((k) => [
        k,
        { key: k, name: `NAME:${k}`, logo: k === "manual" ? undefined : `https://cgk/${k}.png` },
      ]),
    );
  },
} as unknown as Platforms;

describe("buildOverview", () => {
  it("跨账户聚合成一个 Holding + 平台装饰 + 总额", async () => {
    const accounts = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const byAccount = new Map([
      [
        "a1",
        snap("a1", 100, [
          bal({ tokenRef: "eip155:42161/erc20:0xusdc", amount: 100, usdValue: 100 }),
        ]),
      ],
      [
        "a2",
        snap("a2", 50, [
          bal({ kind: "manual", tokenRef: "coingecko:usd-coin", amount: 50, usdValue: 50 }),
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

    // 平台 logo:有图的链平台改写成 folio 代理 URL(key 含 `:` → 编码);manual 无图 → undefined
    //(asset-sheet 对 manual 走 WalletIcon,不请求)。客户端不直引 CoinGecko。
    const platformLogos = view.holdings[0].sources.map((s) => s.platform.logo);
    expect(platformLogos).toContain("/api/logo/platform/eip155%3A42161");
    expect(platformLogos).toContain(undefined);

    expect(view.totalUsd).toBe(150);
    expect(view.holdingsSubtotal).toBe(150);
    expect(view.pricesStale).toBe(false);
    expect(view.sections).toHaveLength(0); // 无 defi/perp
  });

  it("场馆键(= connectorId)走 connectorMeta 装饰,不进 platforms.resolve(#52)", async () => {
    // binance CEX 账户 + 无链前缀 tokenRef → source.platform.id = "binance"(= connectorId,无类别前缀)。
    const accounts = [account("cex", "币安", "binance")];
    const byAccount = new Map([
      [
        "cex",
        snap("cex", 100, [bal({ tokenRef: "coingecko:usd-coin", amount: 100, usdValue: 100 })]),
      ],
    ]);

    // 记录 platforms.resolve 实际被问了哪些 key —— 断言场馆键被排除(无多余 CoinGecko 往返)。
    const asked: string[] = [];
    const recordingPlatforms = {
      async resolve(keys: string[]) {
        asked.push(...keys);
        return new Map(
          keys.map((k) => [k, { key: k, name: `NAME:${k}`, logo: `https://cgk/${k}.png` }]),
        );
      },
    } as unknown as Platforms;
    const connectorMeta = (key: string) =>
      key === "binance" ? { name: "Binance", logo: "https://cgk/markets/binance.jpg" } : null;

    const view = await buildOverview(accounts, byAccount, {
      tokens,
      platforms: recordingPlatforms,
      connectorMeta,
    });

    const src = view.holdings[0].sources[0];
    expect(src.platform.id).toBe("binance");
    expect(src.platform.name).toBe("Binance"); // 连接器自带,非 "NAME:binance"
    expect(src.platform.logo).toBe("/api/logo/platform/binance"); // 代理 URL(无 `:` → 无需编码)
    expect(asked).not.toContain("binance"); // 关键:未进 platforms.resolve → 无 CoinGecko 往返
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
            tokenRef: "coingecko:usd-coin",
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

  it("合法遗留 perp 权益行计入聚合(margin 持有点)", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const meta = JSON.stringify({
      role: "equity",
      withdrawable: 900,
      totalMarginUsed: 100,
      totalNtlPos: 5000,
    });
    const byAccount = new Map([
      ["h", snap("h", 1000, [bal({ kind: "perp", amount: 1000, usdValue: 1000, metaJson: meta })])],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms });
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].totalValue).toBe(1000);
    expect(view.holdings[0].sources[0].isMargin).toBe(true);
  });

  it("脏 metaJson 的遗留 perp 权益行不计入聚合(与明细卡一致,不虚增总额)", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const byAccount = new Map([
      // 损坏 metaJson:viewKind→perp_equity,但 meta 不可解析 → 明细卡与聚合两处都排除
      [
        "h",
        snap("h", 0, [bal({ kind: "perp", amount: 1000, usdValue: 1000, metaJson: "not json" })]),
      ],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms });
    expect(view.holdings).toHaveLength(0);
    expect(view.holdingsSubtotal).toBe(0);
  });
});

// —— H5 #120:sections 的 defi 行读时富化 change24h(协议行 24h 聚合的数据源) ——
// defi 不进聚合,故单独一批 enrich;按 tokenRef 命中的行带 change24h,未命中 undefined。
describe("buildOverview —— defi 行 change24h 富化", () => {
  it("defi 行经 enrich 附回 change24h 进 sections", async () => {
    const defiTokens = {
      async enrich(assets: { symbol: string; providerRef?: string }[]) {
        return assets.map((a) =>
          a?.providerRef ? { change24h: 2.5, priceStale: false } : undefined,
        );
      },
    } as unknown as Tokens;
    const accounts = [account("w", "Wallet")];
    const byAccount = new Map([
      [
        "w",
        snap("w", 100, [
          bal({
            kind: "defi",
            symbol: "stETH",
            amount: 1,
            usdValue: 100,
            tokenRef: "eip155:1/erc20:0xae7a",
            metaJson: JSON.stringify({ protocol: "Lido", positionType: "staked" }),
          }),
          bal({
            kind: "defi",
            symbol: "LP",
            amount: 1,
            usdValue: 50,
            metaJson: JSON.stringify({ protocol: "Uniswap", positionType: "liquidity" }),
          }),
        ]),
      ],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens: defiTokens, platforms });
    const rows = view.sections[0].defi.flatMap((g) => g.rows);
    expect(rows.find((r) => r.symbol === "stETH")?.change24h).toBe(2.5);
    expect(rows.find((r) => r.symbol === "LP")?.change24h).toBeUndefined();
  });
});

// —— H5 评审:sections.account 带平台展示(永续节头体现场馆) ——
describe("buildOverview —— sections.account.platform", () => {
  it("connectorMeta 命中 → name + 代理 logo;未注入 → undefined", async () => {
    const accounts = [account("h", "watch", "hyperliquid")];
    const meta = JSON.stringify({ withdrawable: 1, totalMarginUsed: 0, totalNtlPos: 0 });
    const pos = JSON.stringify({
      side: "long",
      entryPx: 1,
      positionValue: 1,
      unrealizedPnl: 0,
      liquidationPx: null,
      marginUsed: 0,
    });
    const byAccount = new Map([
      [
        "h",
        snap("h", 1, [
          bal({ kind: "perp_equity", amount: 1, usdValue: 1, metaJson: meta }),
          bal({ kind: "perp_position", symbol: "ETH", amount: 1, metaJson: pos }),
        ]),
      ],
    ]);
    const connectorMeta = (key: string) =>
      key === "hyperliquid" ? { key, name: "Hyperliquid", logo: "https://x/hl.png" } : null;
    const withMeta = await buildOverview(accounts, byAccount, { tokens, platforms, connectorMeta });
    expect(withMeta.sections[0].account.platform).toEqual({
      name: "Hyperliquid",
      logo: `/api/logo/platform/${encodeURIComponent("hyperliquid")}`,
    });
    const noMeta = await buildOverview(accounts, byAccount, { tokens, platforms });
    expect(noMeta.sections[0].account.platform).toBeUndefined();
  });
});

// —— code review #7:仅权益、无持仓的 perp 账户保留在 sections(Perps tab 权益条可见) ——
describe("buildOverview —— equity-only perp 账户不被过滤", () => {
  it("有权益无仓位 → sections 保留(perp.equity 非空、positions 空)", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const meta = JSON.stringify({ withdrawable: 900, totalMarginUsed: 0, totalNtlPos: 0 });
    const byAccount = new Map([
      [
        "h",
        snap("h", 1000, [
          bal({ kind: "perp_equity", amount: 1000, usdValue: 1000, metaJson: meta }),
        ]),
      ],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms });
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].perp?.equity?.accountValue).toBe(1000);
    expect(view.sections[0].perp?.positions).toEqual([]);
  });
});
