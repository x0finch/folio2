import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Platforms, TokenRecord, Tokens } from "@folio/oracle";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { buildOverview } from "../src/lib/overview-model";

// 纯 buildOverview 可脱离 server fn 测(依赖注入)—— 这是 #3 抽读模型的收益。
// 用假 tokens/platforms + 最小 fixture,覆盖:eligible 过滤 → enrich 附回 → 聚合 → 平台装饰 → 总额。

const account = (id: string, label: string, connectorId = "evm", platform: string | null = null) =>
  ({ id, label, connectorId, platform, archivedAt: null }) as unknown as AccountSafe;

// 默认都带同一个 token_id —— 认定在写快照时就定死了,读端拿到的就是这个(#201)。
const bal = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "USDC",
  amount: 0,
  usdValue: 0,
  kind: "spot",
  tokenId: "usdc",
  metaJson: null,
  ...over,
});

const snap = (accountId: string, totalUsd: number, balances: OverviewBalance[]) =>
  ({
    snapshot: { accountId, totalUsd, takenAt: 1000 },
    balances,
  }) as unknown as SnapshotWithBalances;

// 假 tokens:**按 token_id 查表**返回整行(证明富化结果被正确挂回并进聚合)。
// 不给价 → liveValue 退回冻结的 usdValue,与迁移前这个 fake 的行为一致。
const record = (id: string): TokenRecord => ({
  id,
  ref: "coingecko/issued:usd-coin",
  symbol: "USDC",
  name: "USD Coin",
  logo: "u.png",
  infoStale: false,
});
const tokens = {
  async enrich(ids: readonly string[]) {
    return new Map(ids.map((id) => [id, record(id)]));
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
          bal({
            platform: "evm:42161",
            amount: 100,
            usdValue: 100,
          }),
        ]),
      ],
      [
        "a2",
        snap("a2", 50, [
          // 手记:ref 的命名者是数据源,平台却是 manual —— 平台只能由 provider 报。
          bal({
            kind: "manual",
            platform: "manual",
            amount: 50,
            usdValue: 50,
          }),
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
      "NAME:evm:42161",
      "NAME:manual",
    ]);

    // 平台 logo:有图的链平台改写成 folio 代理 URL(key 含 `:` → 编码);manual 无图 → undefined
    //(asset-sheet 对 manual 走 WalletIcon,不请求)。客户端不直引 CoinGecko。
    const platformLogos = view.holdings[0].sources.map((s) => s.platform.logo);
    expect(platformLogos).toContain("/api/logo/platform/evm%3A42161");
    expect(platformLogos).toContain(undefined);

    expect(view.totalUsd).toBe(150);
    expect(view.holdingsSubtotal).toBe(150);
    // 这个 fake 不给价 → 「有身份、无价」= 该刷(见下面单独一条)。
    expect(view.pricesStale).toBe(true);
    expect(view.sections).toHaveLength(0); // 无 defi/perp
  });

  // pricesStale 的口径:有 token_id **却拿不到新鲜价**就该让客户端刷一次。
  // 新层刚 mint 出的行正是这样(有身份、无价),漏掉它首屏就永远没价而且没人去取。
  it("价新鲜 → 不标 stale;有身份但没价 / 价过期 → 标 stale", async () => {
    const accounts = [account("a1", "W")];
    const one = (over: Partial<OverviewBalance>) =>
      new Map([["a1", snap("a1", 100, [bal({ amount: 100, usdValue: 100, ...over })])]]);
    const withPrice = (stale: boolean) =>
      ({
        async enrich(ids: readonly string[]) {
          return new Map(
            ids.map((id) => [id, { ...record(id), price: { unitPrice: 1, asOf: 0, stale } }]),
          );
        },
      }) as unknown as Tokens;

    expect(
      (await buildOverview(accounts, one({}), { tokens: withPrice(false), platforms })).pricesStale,
    ).toBe(false);
    expect(
      (await buildOverview(accounts, one({}), { tokens: withPrice(true), platforms })).pricesStale,
    ).toBe(true);
    // 没有身份的行不算 stale —— 刷了也没用(它压根没有可查的键)。
    expect(
      (
        await buildOverview(accounts, one({ tokenId: null }), {
          tokens: withPrice(false),
          platforms,
        })
      ).pricesStale,
    ).toBe(false);
  });

  // #245 Part 2:dust(几乎 $0 的空投/貔貅币)刷价那侧会被跳过,故这侧也不能标脏 —— 否则
  // pricesStale 永清不掉、客户端每次进页空转刷新(与 refreshStalePrices 同用 refreshableTokenIds)。
  it("dust(值 < 阈值)且无价 → 不标 stale(刷价那侧会跳过它)", async () => {
    const accounts = [account("a1", "W")];
    // 无价的 fake tokens(record 不带 price → stale=true 的口径)。
    const noPrice = {
      async enrich(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, record(id)]));
      },
    } as unknown as Tokens;

    // 真持仓(值够)无价 → 该刷;dust(值几乎 0)无价 → 不该刷。
    const real = new Map([["a1", snap("a1", 100, [bal({ usdValue: 100 })])]]);
    const dust = new Map([["a1", snap("a1", 0, [bal({ usdValue: 0.0001 })])]]);

    expect((await buildOverview(accounts, real, { tokens: noPrice, platforms })).pricesStale).toBe(
      true,
    );
    expect((await buildOverview(accounts, dust, { tokens: noPrice, platforms })).pricesStale).toBe(
      false,
    );
  });

  it("场馆键(= connectorId)走 connectorMeta 装饰,不进 platforms.resolve(#52)", async () => {
    // binance CEX 账户 → provider 报 platform = "binance"(场馆键即 connectorId)。
    const accounts = [account("cex", "币安", "binance")];
    const byAccount = new Map([
      ["cex", snap("cex", 100, [bal({ platform: "binance", amount: 100, usdValue: 100 })])],
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

  it("perp 权益不计入代币聚合(#129),改在 sections 的 Perps tab 展示", async () => {
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
    // 代币聚合只认现货 → 权益不在 Holdings、小计里也没有它(避免与 Perps tab 双算)。
    expect(view.holdings).toHaveLength(0);
    expect(view.holdingsSubtotal).toBe(0);
    // 但权益仍在 Perps tab:sections 的 perp.equity 载着账户净值。
    expect(view.sections[0].perp?.equity?.accountValue).toBe(1000);
  });

  it("脏 metaJson 的遗留 perp 权益行:代币聚合空(权益本就不进聚合,#129)", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const byAccount = new Map([
      // 损坏 metaJson:viewKind→perp_equity。#129 后 perp 权益一律不进代币聚合(与是否可解析无关)。
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

// —— #271:法币身份(isFiat)由注入的 fiatRefs(tokenId → fiat 命名者 ref)经 fiatCodeOf 推出 ——
// 身份驱动、**不看裸 symbol**:enrich 记录的 ref 是上游那一档(法币恒 null),故身份单独注入。
describe("buildOverview —— 法币身份 isFiat", () => {
  it("tokenId 命中白名单 fiat/issued ref → Holding.token.isFiat 置真", async () => {
    const accounts = [account("m", "现金", "manual")];
    const byAccount = new Map([
      [
        "m",
        snap("m", 100, [
          bal({ tokenId: "tk-usd", platform: "manual", amount: 100, usdValue: 100 }),
        ]),
      ],
    ]);
    const fiatRefs = new Map([["tk-usd", "fiat/issued:USD"]]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms, fiatRefs });
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].token.isFiat).toBe(true);
    expect(view.holdings[0].totalValue).toBe(100); // 计入净值/聚合
  });

  it("非美元法币(EUR)同样置真", async () => {
    const accounts = [account("m", "现金", "manual")];
    const byAccount = new Map([
      [
        "m",
        snap("m", 50, [bal({ tokenId: "tk-eur", platform: "manual", amount: 50, usdValue: 55 })]),
      ],
    ]);
    const fiatRefs = new Map([["tk-eur", "fiat/issued:EUR"]]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms, fiatRefs });
    expect(view.holdings[0].token.isFiat).toBe(true);
  });

  it("ref 非白名单 fiat(如上游 usd 代币)→ 不算法币(以 ref 为准,不撞 symbol)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-x", amount: 100, usdValue: 100 })])],
    ]);
    // symbol 恰好是 USD,但 fiatRefs 给的是上游命名的普通代币 ref → fiatCodeOf 判非法币。
    const fiatRefs = new Map([["tk-x", "coingecko/issued:some-usd-token"]]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms, fiatRefs });
    expect(view.holdings[0].token.isFiat).toBe(false);
  });

  it("无 fiatRefs 注入 → 一律非法币(缺省安全)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-usd", amount: 100, usdValue: 100 })])],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens, platforms });
    expect(view.holdings[0].token.isFiat).toBe(false);
  });
});

// —— H5 #120:sections 的 defi 行读时富化 change24h(协议行 24h 聚合的数据源) ——
// defi 不进聚合,故单独一批 enrich;按 tokenRef 命中的行带 change24h,未命中 undefined。
describe("buildOverview —— defi 行 change24h 富化", () => {
  it("defi 行经 enrich 附回 change24h 进 sections", async () => {
    // 只有 tk-staked 有价 → 只有那一行拿到 change24h;另一行(LP 份额)没有身份,不该被瞎猜。
    const defiTokens = {
      async enrich(ids: readonly string[]) {
        return new Map(
          ids
            .filter((id) => id === "tk-staked")
            .map((id) => [
              id,
              { ...record(id), price: { unitPrice: 1, change24h: 2.5, asOf: 0, stale: false } },
            ]),
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
            tokenId: "tk-staked",
            metaJson: JSON.stringify({ protocol: "Lido", positionType: "staked" }),
          }),
          bal({
            kind: "defi",
            symbol: "LP",
            amount: 1,
            usdValue: 50,
            tokenId: null, // LP 份额没有代币身份
            metaJson: JSON.stringify({ protocol: "Uniswap", positionType: "liquidity" }),
          }),
        ]),
      ],
    ]);
    const view = await buildOverview(accounts, byAccount, { tokens: defiTokens, platforms });
    // 按协议组定位(#243:展示 symbol 现从 Token 取,不再是余额那份 stETH/LP)。
    const defi = view.sections[0].defi;
    expect(defi.find((g) => g.protocol === "Lido")?.rows[0].change24h).toBe(2.5);
    expect(defi.find((g) => g.protocol === "Uniswap")?.rows[0].change24h).toBeUndefined();
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
