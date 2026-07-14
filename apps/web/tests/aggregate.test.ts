import type { CgkCoinId, TokenGroup, TokenRef } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { type AggInput, buildCanonicalHoldings, type Holding } from "../src/lib/aggregate";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const usdt: TokenGroup = { id: "usdt", displaySymbol: "USDT", name: "Tether USD" };
const usdc: TokenGroup = { id: "usdc", displaySymbol: "USDC", name: "USD Coin" };
const zerion = { id: "z1", label: "Wallet", connectorId: "evm" };
const binance = { id: "b1", label: "Binance", connectorId: "binance" };
const hyper = { id: "h1", label: "HL", connectorId: "hyperliquid" };
const manual = { id: "m1", label: "备注", connectorId: "manual" };

const row = (
  p: Partial<AggInput> & Pick<AggInput, "symbol" | "amount" | "value" | "account">,
): AggInput => ({
  kind: "spot",
  ...p,
});
const byKey = (hs: Holding[], key: string) => hs.find((h) => h.key === key);

describe("buildCanonicalHoldings", () => {
  it("USDT 跨链 + 交易所 + manual → 一个 Holding,链级拆分,跨 Token 不给 totalAmount", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDT",
        amount: 1000,
        value: 1000,
        tokenKey: "eip155:1/erc20:0xdac",
        account: zerion,
        group: usdt,
        ref: cg("tether"),
      }),
      row({
        symbol: "USDT",
        amount: 500,
        value: 500,
        tokenKey: "eip155:42161/erc20:0xfd0",
        account: zerion,
        group: usdt,
        ref: cg("usdt0"),
      }),
      row({
        symbol: "USDT",
        amount: 2000,
        value: 2000,
        account: binance,
        group: usdt,
        ref: cg("tether"),
      }),
      row({
        symbol: "USDT",
        amount: 100,
        value: 100,
        kind: "spot", // 归一后 manual→spot(overview 用 viewKind 归一后才喂 aggregate)
        tokenKey: "coingecko:tether",
        account: manual,
        group: usdt,
        ref: cg("tether"),
      }),
    ]);
    expect(hs).toHaveLength(1);
    const h = hs[0]!;
    expect(h.key).toBe("group:usdt");
    expect(h.token).toMatchObject({ id: "usdt", symbol: "USDT", name: "Tether USD" });
    expect(h.totalValue).toBe(3600);
    expect(h.totalAmount).toBeUndefined(); // tether + usdt0 = 2 个 Token
    // aggregate 只产 platform.id(key);name 仅为 key 占位,真名/logo 由 server 读路径
    // platforms.resolve 装饰(平台"显示成什么"整个归 @folio/platforms)。
    const ids = ["binance", "eip155:1", "eip155:42161", "manual"]; // value 降序(场馆键 = connectorId)
    expect(h.sources.map((s) => s.platform.id)).toEqual(ids);
    expect(h.sources.map((s) => s.platform.name)).toEqual(ids); // name == key 占位
  });

  it("单一 Token 组给 totalAmount;perp 权益作 isMargin 持有点", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDC",
        amount: 1000,
        value: 1000,
        tokenKey: "eip155:1/erc20:0xa0b",
        account: zerion,
        group: usdc,
        ref: cg("usd-coin"),
      }),
      row({
        symbol: "USDC",
        amount: 500,
        value: 500,
        tokenKey: "eip155:42161/erc20:0xaf8",
        account: zerion,
        group: usdc,
        ref: cg("usd-coin"),
      }),
      row({
        symbol: "USDC",
        amount: 300,
        value: 300,
        kind: "perp_equity",
        isMargin: true,
        account: hyper,
        group: usdc,
        ref: cg("usd-coin"),
      }),
    ]);
    const h = byKey(hs, "group:usdc")!;
    expect(h.totalValue).toBe(1800);
    expect(h.totalAmount).toBe(1800); // 全是 usd-coin,单一 Token
    const margin = h.sources.find((s) => s.platform.id === "hyperliquid")!;
    expect(margin.isMargin).toBe(true);
    expect(margin.platform.name).toBe("hyperliquid"); // name = key 占位(场馆键 = connectorId;真名由读路径装饰)
  });

  it("桥接/未分组不并入本尊;未解析按账户隔离,绝不与已解析同 symbol 合并", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDT",
        amount: 1000,
        value: 1000,
        account: binance,
        group: usdt,
        ref: cg("tether"),
      }), // 已解析 → 组
      row({
        symbol: "USDT",
        amount: 100,
        value: 100,
        tokenKey: "eip155:43114/erc20:0xc7",
        account: zerion,
        ref: cg("usdt-avalanche"),
      }), // 无组 → 单例 Token
      row({
        symbol: "USDT",
        amount: 50,
        value: 50,
        account: { id: "k1", label: "Kraken", connectorId: "kraken" },
      }), // 未解析 → account:symbol(kraken 未接线,仅作 fallback 素材)
    ]);
    expect(hs).toHaveLength(3);
    expect(byKey(hs, "group:usdt")?.totalValue).toBe(1000);
    expect(byKey(hs, "token:coingecko:usdt-avalanche")?.totalValue).toBe(100);
    expect(byKey(hs, "as:k1:USDT")?.totalValue).toBe(50);
  });

  it("白名单:defi / perp 仓位(非保证金)不进 Holdings", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "ETH",
        amount: 1,
        value: 3000,
        kind: "defi",
        account: zerion,
        ref: cg("ethereum"),
      }),
      row({
        symbol: "ETH",
        amount: 1,
        value: 0,
        kind: "perp_position",
        account: hyper,
        ref: cg("ethereum"),
      }), // 仓位:isMargin 未置
    ]);
    expect(hs).toHaveLength(0);
  });

  it("account×chain 去重:同账户同链同币两条 → 一个 source", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDC",
        amount: 100,
        value: 100,
        tokenKey: "eip155:1/erc20:0xa0b",
        account: zerion,
        group: usdc,
        ref: cg("usd-coin"),
      }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        tokenKey: "eip155:1/erc20:0xa0b",
        account: zerion,
        group: usdc,
        ref: cg("usd-coin"),
      }),
    ]);
    const h = byKey(hs, "group:usdc")!;
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]).toMatchObject({ amount: 150, value: 150 });
  });

  it("同一内部 tokenId、不同 ref → 归并成一个 Holding(#46 去 vendor tag,归并按内部 id 不按 refKey)", () => {
    // 同一个币,两笔行带不同的 vendor 引用(模拟换源前后 refKey 会不同:如 coingecko:x vs 新源 id),
    // 但富化都命中同一个内部代币行 → tokenId 相同。按内部 id 归并 → 不碎(旧按 refKey 会分成两个)。
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDC",
        amount: 100,
        value: 100,
        account: binance,
        tokenId: "tok-1",
        ref: cg("usd-coin"),
      }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        account: hyper,
        tokenId: "tok-1",
        ref: cg("usd-coin-legacy"), // 不同 refKey,但同一内部 id
      }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.key).toBe("token:tok-1"); // 归并键 = 内部 id,非 refKey
    expect(hs[0]!.totalValue).toBe(150);
    expect(hs[0]!.totalAmount).toBe(150); // 组内单一 Token(同 tokenId)→ 给 totalAmount
    expect(hs[0]!.token.id).toBe("tok-1");
  });

  it("不同内部 tokenId → 保持两个 Holding(内部 id 是归并身份的事实源)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "AAA", amount: 1, value: 10, account: binance, tokenId: "tok-a" }),
      row({ symbol: "BBB", amount: 1, value: 20, account: binance, tokenId: "tok-b" }),
    ]);
    expect(hs).toHaveLength(2);
  });

  it("无美元价值(未定价/垃圾币,value=0)→ 不进组合持仓", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "REAL", amount: 2, value: 50, account: binance, tokenId: "tok-real" }),
      row({ symbol: "SPAM", amount: 999999, value: 0, account: binance, tokenId: "tok-spam" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.token.symbol).toBe("REAL");
  });

  it("同代币多源合计 > 0 仍保留,即使个别源 value=0", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "AAA", amount: 1, value: 0, account: binance, tokenId: "tok-a" }),
      row({ symbol: "AAA", amount: 1, value: 5, account: hyper, tokenId: "tok-a" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(5);
  });
});
