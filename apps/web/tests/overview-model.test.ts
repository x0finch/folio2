import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import type { TokenRecord } from "@folio/oracle-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import {
  buildOverview,
  deriveLiveAccountTotals,
  GAIN_WINDOW_MS,
  isFirstSyncPending,
  type OverviewInput,
  overviewChainIds,
  overviewEligibleBalances,
  overviewEnrichIds,
  type PortfolioSnapshotData,
  toTokenView,
} from "@/lib/core/portfolio";
import { refreshableTokenIds } from "@/lib/core/token-model";
import { type OracleStub, runWithOracle } from "./oracle-stub";

// 纯 buildOverview 可脱离 server fn 测(依赖注入)—— 这是 #3 抽读模型的收益。
// 用假 tokens/platforms + 最小 fixture,覆盖:eligible 过滤 → enrich 附回 → 聚合 → 平台装饰 → 总额。
//
// FOL-45 起 buildOverview 是**纯函数**:富化 / 现推净值 / 平台元数据 / 刷价集合都由调用点在
// Effect 里备好再传进去。这个 `overviewEffect` 就是那层薄适配(与 `buildScopedOverview` 逐字同款),
// 让每条用例仍旧 `runWithOracle(stub, …)`,只是被测的算术已从 Effect 里拆出来了。
type OverviewDeps = Omit<
  OverviewInput,
  "enriched" | "liveTotals" | "platformMeta" | "refreshableIds"
>;
const overviewEffect = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  deps: OverviewDeps = {},
) =>
  Effect.gen(function* () {
    const { tokens, platforms } = yield* Oracle;
    // 与生产 `scopedSnapshotMaterials` 同款:参考层读出的完整行经 `toTokenView` 收窄再喂 buildOverview。
    const enrichedRecords = yield* tokens.enrich(overviewEnrichIds(accounts, byAccount));
    const enriched = new Map([...enrichedRecords].map(([id, r]) => [id, toTokenView(r)] as const));
    const platformMeta = yield* platforms.resolve(
      overviewChainIds(accounts, byAccount, deps.connectorMeta),
    );
    const liveTotals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enriched,
      deps.mode ?? "self-first",
    );
    const refreshableIds = new Set(
      refreshableTokenIds(overviewEligibleBalances(accounts, byAccount)),
    );
    return buildOverview(accounts, byAccount, {
      ...deps,
      enriched,
      liveTotals,
      platformMeta,
      refreshableIds,
    });
  });

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
  enrich: (ids: readonly string[]) => Effect.succeed(new Map(ids.map((id) => [id, record(id)]))),
};

// 假 platforms:每个 key 回 "NAME:<key>";manual 无上游图(真实 resolve 对未收录/未 warm 的 key
// 不带 logo)。验证读路径装饰覆写占位名,并把有图的平台 logo 改写成代理 URL、无图的置 undefined。
const platforms = {
  resolve: (keys: readonly string[]) =>
    Effect.succeed(
      new Map(
        keys.map((k) => [
          k,
          { key: k, name: `NAME:${k}`, logo: k === "manual" ? undefined : `https://cgk/${k}.png` },
        ]),
      ),
    ),
};

// 这一组的默认桩:富化按 token_id 查表、平台按 key 造名。用例只在需要时换掉其中一个。
const stub: OracleStub = { tokens, platforms };

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

    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));

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
    //(token-sheet 对 manual 走 WalletIcon,不请求)。客户端不直引 CoinGecko。
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
    const withPrice = (stale: boolean) => ({
      enrich: (ids: readonly string[]) =>
        Effect.succeed(
          new Map(
            ids.map((id) => [id, { ...record(id), price: { unitPrice: 1, asOf: 0, stale } }]),
          ),
        ),
    });

    expect(
      (
        await runWithOracle(
          { ...stub, tokens: withPrice(false) },
          overviewEffect(accounts, one({}), {}),
        )
      ).pricesStale,
    ).toBe(false);
    expect(
      (
        await runWithOracle(
          { ...stub, tokens: withPrice(true) },
          overviewEffect(accounts, one({}), {}),
        )
      ).pricesStale,
    ).toBe(true);
    // 没有身份的行不算 stale —— 刷了也没用(它压根没有可查的键)。
    expect(
      (
        await runWithOracle(
          { ...stub, tokens: withPrice(false) },
          overviewEffect(accounts, one({ tokenId: null }), {}),
        )
      ).pricesStale,
    ).toBe(false);
  });

  // #245 Part 2:dust(几乎 $0 的空投/貔貅币)刷价那侧会被跳过,故这侧也不能标脏 —— 否则
  // pricesStale 永清不掉、客户端每次进页空转刷新(与 refreshStalePrices 同用 refreshableTokenIds)。
  it("dust(值 < 阈值)且无价 → 不标 stale(刷价那侧会跳过它)", async () => {
    const accounts = [account("a1", "W")];
    // 无价的 fake tokens(record 不带 price → stale=true 的口径)。
    const noPrice = {
      enrich: (ids: readonly string[]) =>
        Effect.succeed(new Map(ids.map((id) => [id, record(id)]))),
    };

    // 真持仓(值够)无价 → 该刷;dust(值几乎 0)无价 → 不该刷。
    const real = new Map([["a1", snap("a1", 100, [bal({ usdValue: 100 })])]]);
    const dust = new Map([["a1", snap("a1", 0, [bal({ usdValue: 0.0001 })])]]);

    expect(
      (await runWithOracle({ ...stub, tokens: noPrice }, overviewEffect(accounts, real, {})))
        .pricesStale,
    ).toBe(true);
    expect(
      (await runWithOracle({ ...stub, tokens: noPrice }, overviewEffect(accounts, dust, {})))
        .pricesStale,
    ).toBe(false);
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
      resolve: (keys: readonly string[]) =>
        Effect.sync(() => {
          asked.push(...keys);
          return new Map(
            keys.map((k) => [k, { key: k, name: `NAME:${k}`, logo: `https://cgk/${k}.png` }]),
          );
        }),
    };
    const connectorMeta = (key: string) =>
      key === "binance" ? { name: "Binance", logo: "https://cgk/markets/binance.jpg" } : null;

    const view = await runWithOracle(
      { ...stub, platforms: recordingPlatforms },
      overviewEffect(accounts, byAccount, { connectorMeta }),
    );

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

    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));

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
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
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
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
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
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
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
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
    expect(view.holdings[0].token.isFiat).toBe(true);
  });

  it("ref 非白名单 fiat(如上游 usd 代币)→ 不算法币(以 ref 为准,不撞 symbol)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-x", amount: 100, usdValue: 100 })])],
    ]);
    // symbol 恰好是 USD,但 fiatRefs 给的是上游命名的普通代币 ref → fiatCodeOf 判非法币。
    const fiatRefs = new Map([["tk-x", "coingecko/issued:some-usd-token"]]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
    expect(view.holdings[0].token.isFiat).toBe(false);
  });

  it("无 fiatRefs 注入 → 一律非法币(缺省安全)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-usd", amount: 100, usdValue: 100 })])],
    ]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.holdings[0].token.isFiat).toBe(false);
  });
});

// —— H5 #120:sections 的 defi 行读时富化 change24h(协议行 24h 聚合的数据源) ——
// defi 不进聚合,故单独一批 enrich;按 tokenRef 命中的行带 change24h,未命中 undefined。
describe("buildOverview —— defi 行 change24h 富化", () => {
  it("defi 行经 enrich 附回 change24h 进 sections", async () => {
    // 只有 tk-staked 有价 → 只有那一行拿到 change24h;另一行(LP 份额)没有身份,不该被瞎猜。
    const defiTokens = {
      enrich: (ids: readonly string[]) =>
        Effect.succeed(
          new Map(
            ids
              .filter((id) => id === "tk-staked")
              .map((id) => [
                id,
                { ...record(id), price: { unitPrice: 1, change24h: 2.5, asOf: 0, stale: false } },
              ]),
          ),
        ),
    };
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
    const view = await runWithOracle(
      { ...stub, tokens: defiTokens },
      overviewEffect(accounts, byAccount, {}),
    );
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
    const withMeta = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { connectorMeta }),
    );
    expect(withMeta.sections[0].account.platform).toEqual({
      name: "Hyperliquid",
      logo: `/api/logo/platform/${encodeURIComponent("hyperliquid")}`,
    });
    const noMeta = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
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
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].perp?.equity?.accountValue).toBe(1000);
    expect(view.sections[0].perp?.positions).toEqual([]);
  });
});

describe("buildOverview —— 24h 盈亏接线(ADR 0040)", () => {
  const NOW = 1_700_000_000_000;
  const FROM = NOW - GAIN_WINDOW_MS;
  const accounts = [account("a1", "Arb")];
  // 当下:1 个 USDC,现推市值 110(默认桩不给价 → liveValue 退回冻结的 usdValue,所以直接写 110)。
  const byAccount = new Map([["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])]]);

  it("有历史 → 行上带真实盈亏,而不是市场涨跌幅倒推的数", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, {
        now: NOW,
        gainHistory: [
          { accountId: "a1", takenAt: FROM, tokenId: "usdc", amount: 1, usdValue: 100 },
        ],
      }),
    );
    expect(view.holdings[0].gain24h?.amount).toBeCloseTo(10, 6);
    expect(view.holdings[0].gain24h?.pct).toBeCloseTo(10, 6);
  });

  it("当天新建的仓 —— 账户那时有快照但没这个币 → 盈亏 0,不是一整天的涨幅", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, {
        now: NOW,
        // 那一刻账户里是另一个币 → USDC 的基准点是 (FROM, 0, 0)
        gainHistory: [
          { accountId: "a1", takenAt: FROM, tokenId: "eth", amount: 1, usdValue: 3000 },
        ],
      }),
    );
    expect(view.holdings.find((h) => h.key === "usdc")?.gain24h?.amount).toBe(0);
  });

  it("没有历史(缺基准)→ null,由界面渲染 `—`,不是 0", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { now: NOW, gainHistory: [] }),
    );
    expect(view.holdings[0].gain24h).toBeNull();
  });

  it("不传入历史 → 不算盈亏(字段缺席)。首页总览走这条", async () => {
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { now: NOW }));
    expect(view.holdings[0].gain24h).toBeUndefined();
    expect(view.gain24h).toBeUndefined();
  });

  it("各行金额相加 = 把所有线一起算 —— 「加得起来」是结构上成立的", async () => {
    const two = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const snaps = new Map([
      ["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])],
      ["a2", snap("a2", 62, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 62 })])],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(two, snaps, {
        now: NOW,
        gainHistory: [
          { accountId: "a1", takenAt: FROM, tokenId: "usdc", amount: 1, usdValue: 100 },
          { accountId: "a2", takenAt: FROM, tokenId: "eth", amount: 2, usdValue: 60 },
        ],
      }),
    );
    const sum = view.holdings.reduce((s, h) => s + (h.gain24h?.amount ?? 0), 0);
    expect(sum).toBeCloseTo(12, 6); // +10(USDC)+2(ETH)
    // **这条是第 4 片的验收核心**:hero 那个数就是各行之和,而这是现在做不到的事。
    expect(view.gain24h?.amount).toBeCloseTo(sum, 6);
  });

  it("组合百分比是统一时间轴上的连乘,不是各行百分比取平均", async () => {
    const two = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const snaps = new Map([
      ["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])],
      ["a2", snap("a2", 62, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 62 })])],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(two, snaps, {
        now: NOW,
        gainHistory: [
          { accountId: "a1", takenAt: FROM, tokenId: "usdc", amount: 1, usdValue: 100 },
          { accountId: "a2", takenAt: FROM, tokenId: "eth", amount: 2, usdValue: 60 },
        ],
      }),
    );
    // 各行:+10%(100→110)与 +3.33%(60→62);组合基数 160 → 12/160 = 7.5%,不是两者的平均 6.67%
    const avg = view.holdings.reduce((s, h) => s + (h.gain24h?.pct ?? 0), 0) / view.holdings.length;
    expect(view.gain24h?.pct).toBeCloseTo(7.5, 4);
    expect(view.gain24h?.pct).not.toBeCloseTo(avg, 2);
  });

  it("一条线都算不出 → 组合层也是 null,由 hero 渲染 `—`", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { now: NOW, gainHistory: [] }),
    );
    expect(view.gain24h).toBeNull();
  });
});

describe("buildOverview —— DeFi 协议行的 24h 盈亏(ADR 0040 的已知妥协)", () => {
  const NOW = 1_700_000_000_000;
  const FROM = NOW - GAIN_WINDOW_MS;
  const lidoMeta = JSON.stringify({ protocol: "Lido", positionType: "staked" });
  const accounts = [account("w", "Wallet")];
  const byAccount = new Map([
    [
      "w",
      snap("w", 110, [
        bal({ kind: "defi", amount: 1, usdValue: 110, tokenId: "tk-staked", metaJson: lidoMeta }),
      ]),
    ],
  ]);
  const defiHist = (usdValue: number, meta = lidoMeta) => ({
    accountId: "w",
    takenAt: FROM,
    tokenId: "tk-staked",
    amount: 1,
    usdValue,
    kind: "defi",
    metaJson: meta,
  });

  it("拿两张照片的价值相减 —— 没有「几个币」可依,只能这样", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { now: NOW, gainHistory: [defiHist(100)] }),
    );
    expect(view.sections[0].defi[0].gain24h?.amount).toBeCloseTo(10, 6);
  });

  it("百分比分母是**总敞口**,不是净值 —— 对冲仓才不会给出荒唐的数", async () => {
    // 存 100 万 / 借 99 万:净值只剩 1 万。拿净值当分母,涨 1 万会算成 +100%。
    const hedged = new Map([
      [
        "w",
        snap("w", 20_000, [
          bal({ kind: "defi", amount: 1, usdValue: 1_010_000, tokenId: "sup", metaJson: lidoMeta }),
          bal({ kind: "defi", amount: 1, usdValue: -990_000, tokenId: "bor", metaJson: lidoMeta }),
        ]),
      ],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, hedged, {
        now: NOW,
        gainHistory: [
          { ...defiHist(1_000_000), tokenId: "sup" },
          { ...defiHist(-990_000), tokenId: "bor" },
        ],
      }),
    );
    const gain = view.sections[0].defi[0];
    expect(gain.gain24h?.amount).toBeCloseTo(10_000, 6);
    // 总敞口 199 万 → 约 +0.50%;净值当分母会给出 +100%
    expect(gain.gain24h?.pct).toBeCloseTo(0.5, 2);
    expect(gain.gain24h?.pct).not.toBeCloseTo(100, 0);
  });

  it("没有历史 → null,由界面渲染 `—`", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { now: NOW, gainHistory: [] }),
    );
    expect(view.sections[0].defi[0].gain24h).toBeNull();
  });
});

describe("buildOverview —— DeFi 盈亏的分母要带着走", () => {
  // 总览的 DeFi tab 跨账户合并协议组时,要用 Σ金额 ÷ Σ总敞口 重算百分比。分母没带过去的话,
  // 合并后的百分比会恒为 null —— 而单账户视图里它是对的,所以这个洞只在合并那一侧才看得见。
  it("gain24h 带 grossBasis(合并那一侧要用)", async () => {
    const NOW = 1_700_000_000_000;
    const meta = JSON.stringify({ protocol: "Lido", positionType: "staked" });
    const view = await runWithOracle(
      stub,
      overviewEffect(
        [account("w", "Wallet")],
        new Map([
          ["w", snap("w", 110, [bal({ kind: "defi", amount: 1, usdValue: 110, metaJson: meta })])],
        ]),
        {
          now: NOW,
          gainHistory: [
            {
              accountId: "w",
              takenAt: NOW - GAIN_WINDOW_MS,
              tokenId: "usdc",
              amount: 1,
              usdValue: 100,
              kind: "defi",
              metaJson: meta,
            },
          ],
        },
      ),
    );
    expect(view.sections[0].defi[0].gain24h?.grossBasis).toBeCloseTo(100, 6);
  });
});

// 首次同步中的判据(FOL-48 回归修复):有账户、还没有任何快照 = 显加载态,不是把 $0 当答案。
// 只读 `accounts` / `snapshots` 两片,构造最小原料即可。
describe("isFirstSyncPending", () => {
  const raw = (accounts: number, snapshots: number): PortfolioSnapshotData =>
    ({
      accounts: Array.from({ length: accounts }, (_, i) => ({ id: `a${i}` })),
      snapshots: Array.from({ length: snapshots }, (_, i) => [`a${i}`, {}]),
    }) as unknown as PortfolioSnapshotData;

  it("有账户、零快照 → 首次同步中", () => {
    expect(isFirstSyncPending(raw(2, 0))).toBe(true);
  });

  it("零账户(真的空组合)→ 不是 pending,照常画空态", () => {
    expect(isFirstSyncPending(raw(0, 0))).toBe(false);
  });

  it("至少一张快照落地 → 不再 pending", () => {
    expect(isFirstSyncPending(raw(2, 1))).toBe(false);
  });

  it("原料还没到(undefined)→ 不是 pending", () => {
    expect(isFirstSyncPending(undefined)).toBe(false);
  });
});
