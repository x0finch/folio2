import { describe, expect, it } from "vitest";
import {
  type AggInput,
  buildCanonicalHoldings,
  type Holding,
} from "../src/lib/server/internal/aggregate";

// 聚合的归并键 = `token_id`(ADR 0021 / #201)。认定在写快照时由 mint 定死,读端不再解析 ——
// 所以这些用例直接给 token_id,不再造 `tokenRef` / `ref` 让聚合自己猜。
// 「谁跟谁并成一行」的判断因此从聚合层整个搬走了:这里只验「同 id 并、不同 id 不并」以及
// 平台单元 / 合计 / 排序那些真属于本层的事。

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
  // ADR 0021:展示分组退场 —— 桥接变体是**另一个 token_id**,因此天然另成一行。
  it("同一个 Token 跨链 + 交易所 + 手记 → 一行;桥接变体另成一行,总额不变", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDT",
        amount: 1000,
        value: 1000,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdt",
      }),
      // 桥接变体:mint 认成了另一个币 → 另一个 token_id。
      row({
        symbol: "USDT",
        amount: 500,
        value: 500,
        platform: "evm:42161",
        account: zerion,
        tokenId: "tk-usdt0",
      }),
      row({
        symbol: "USDT",
        amount: 2000,
        value: 2000,
        platform: "binance",
        account: binance,
        tokenId: "tk-usdt",
      }),
      row({
        symbol: "USDT",
        amount: 100,
        value: 100,
        // 手记的平台是 manual —— 平台读余额行报来的那一列,与代币身份无关。
        platform: "manual",
        account: manual,
        tokenId: "tk-usdt",
      }),
    ]);
    expect(hs).toHaveLength(2);
    const h = byKey(hs, "tk-usdt")!;
    expect(h.token).toMatchObject({ symbol: "USDT" });
    expect(h.totalValue).toBe(3100);
    expect(h.totalAmount).toBe(3100); // 同一 Token 的多源(链 + 交易所 + 手记)合计总枚数
    // aggregate 只产 platform.id(key);name 仅为 key 占位,真名/logo 由 server 读路径
    // platforms.resolve 装饰(平台"显示成什么"整个归 @folio/platforms)。
    const ids = ["binance", "evm:1", "manual"]; // value 降序(场馆键 = connectorId)
    expect(h.sources.map((s) => s.platform.id)).toEqual(ids);
    expect(h.sources.map((s) => s.platform.name)).toEqual(ids); // name == key 占位
    expect(byKey(hs, "tk-usdt0")?.totalValue).toBe(500);
    expect(hs.reduce((n, x) => n + x.totalValue, 0)).toBe(3600);
  });

  it("perp 权益不进聚合(#129):同 token 的现货并成一行,权益那笔被排除、其持有点也不出现", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 1000, value: 1000, account: zerion, tokenId: "tk-usdc" }),
      row({ symbol: "USDC", amount: 500, value: 500, account: zerion, tokenId: "tk-usdc" }),
      row({
        symbol: "USDC",
        amount: 300,
        value: 300,
        kind: "perp_equity", // 永续权益 —— 只应出现在 Perps tab,不折进代币行
        account: hyper,
        tokenId: "tk-usdc",
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.totalValue).toBe(1500); // 只两笔现货,权益 300 不计
    expect(h.totalAmount).toBe(1500);
    // 权益来自 hyperliquid 账户 → 该持有点根本不该出现在这一行
    expect(h.sources.find((s) => s.platform.id === "hyperliquid")).toBeUndefined();
  });

  it("不同 token_id → 各自成行(内部 id 是归并身份的唯一事实源)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "AAA", amount: 1, value: 10, account: binance, tokenId: "tk-a" }),
      row({ symbol: "BBB", amount: 1, value: 20, account: binance, tokenId: "tk-b" }),
    ]);
    expect(hs).toHaveLength(2);
  });

  // #243 删了快照 symbol 列后,没有 token_id 的行(只剩 v2 导入进来的)symbol 为空。若还拿 symbol
  // 当兜底键,同一账户里所有无 token 的行会塌成一条空名持仓、金额被错误相加。兜底改用余额行 id
  // → 各自独立成行,金额不混。
  it("无 token_id 的行按余额行 id 各自成行,不塌成一条空名合并行", () => {
    const hs = buildCanonicalHoldings([
      row({ id: "bal-1", symbol: "", amount: 1, value: 10, account: binance }),
      row({ id: "bal-2", symbol: "", amount: 1, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
    expect(hs.map((h) => h.totalValue).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  // 同一个 Token 被不同来源报出(交易所 / 链上),读端只看 token_id → 一行。
  // 换源之后上游 id 变了也不碎:token_id 是 vendor 中立的。
  it("同一个 token_id、来源不同 → 一行", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 100, value: 100, account: binance, tokenId: "tk-1" }),
      row({ symbol: "USDC", amount: 50, value: 50, account: hyper, tokenId: "tk-1" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.key).toBe("tk-1");
    expect(hs[0]!.totalValue).toBe(150);
    expect(hs[0]!.totalAmount).toBe(150);
    expect(hs[0]!.token.id).toBe("tk-1");
  });

  it("白名单:defi / perp 仓位不进 Holdings(只认现货)", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "ETH",
        amount: 1,
        value: 3000,
        kind: "defi",
        account: zerion,
        tokenId: "tk-e",
      }),
      row({
        symbol: "ETH",
        amount: 1,
        value: 0,
        kind: "perp_position",
        account: hyper,
        tokenId: "tk-e",
      }), // perp 仓位(value=0),不进聚合
    ]);
    expect(hs).toHaveLength(0);
  });

  it("account×platform 去重:同账户同平台同币两条 → 一个 source", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDC",
        amount: 100,
        value: 100,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdc",
      }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdc",
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]).toMatchObject({ amount: 150, value: 150 });
  });

  it("无美元价值(未定价/垃圾币,value=0)→ 不进组合持仓", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "REAL", amount: 2, value: 50, account: binance, tokenId: "tk-real" }),
      row({ symbol: "SPAM", amount: 999999, value: 0, account: binance, tokenId: "tk-spam" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.token.symbol).toBe("REAL");
  });

  it("同代币多源合计 > 0 仍保留,即使个别源 value=0", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "AAA", amount: 1, value: 0, account: binance, tokenId: "tk-a" }),
      row({ symbol: "AAA", amount: 1, value: 5, account: hyper, tokenId: "tk-a" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(5);
  });

  it("token 带 unitPrice / marketCapRank(详情头部 meta 用)", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "BTC",
        amount: 1,
        value: 64789,
        account: binance,
        tokenId: "tk-btc",
        unitPrice: 64789,
        marketCapRank: 1,
      }),
    ]);
    expect(hs[0]!.token.unitPrice).toBe(64789);
    expect(hs[0]!.token.marketCapRank).toBe(1);
  });

  it("多源组价/排名取「首个有值」:首行无价也不漏(不依赖行序)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 100, value: 100, account: zerion, tokenId: "tk-usdc" }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        account: binance,
        tokenId: "tk-usdc",
        unitPrice: 1,
        marketCapRank: 6,
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.token.unitPrice).toBe(1);
    expect(h.token.marketCapRank).toBe(6);
  });

  // 一组恒是一个 Token,所以行内涨跌无条件给 —— 以前那个「组内是否单一身份」的判断
  // 在键塌成一级之后恒为真,已随三级键一并删除。
  it("行内 24h 涨跌无条件给", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "BTC",
        amount: 1,
        value: 60,
        account: binance,
        tokenId: "tk-btc",
        change24h: 3,
      }),
      row({ symbol: "BTC", amount: 1, value: 60, account: hyper, tokenId: "tk-btc" }),
    ]);
    expect(hs[0]!.change24h).toBe(3);
  });

  it("平台单元 = provider 报的 platform(不从代币身份反推)", () => {
    const btc = { id: "x1", label: "BTC wallet", connectorId: "bitcoin" };
    const hs = buildCanonicalHoldings([
      row({
        symbol: "BTC",
        amount: 1,
        value: 60,
        platform: "bitcoin",
        account: btc,
        tokenId: "tk-btc",
      }),
      row({
        symbol: "ETH",
        amount: 1,
        value: 30,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-eth",
      }),
    ]);
    expect(hs.flatMap((h) => h.sources.map((s) => s.platform.id)).sort()).toEqual([
      "bitcoin",
      "evm:1",
    ]);
  });

  it("没报 platform 的行 → 退回账户的 connectorId", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 100, value: 100, account: binance, tokenId: "tk-usdc" }),
    ]);
    expect(hs[0]!.sources.map((s) => s.platform.id)).toEqual(["binance"]);
  });
});

// 没有 token_id 的行只剩两类:本列之前写下的旧快照,和手记那种现造的持仓(#203 之后就没了)。
describe("没有 token_id 的兜底", () => {
  it("按 账户 + symbol 各自成组 —— **绝不**跨账户按裸 symbol 并(ADR-0002 的红线)", () => {
    const kraken = { id: "k1", label: "Kraken", connectorId: "kraken" };
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, account: kraken }),
      row({ symbol: "USDT", amount: 70, value: 70, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
    expect(byKey(hs, "no-token:k1:USDT")?.totalValue).toBe(50);
    expect(byKey(hs, "no-token:b1:USDT")?.totalValue).toBe(70);
  });

  it("同账户同 symbol 的多行仍并到一起(那确实是同一笔持仓的多个来源)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, platform: "binance", account: binance }),
      row({ symbol: "USDT", amount: 20, value: 20, platform: "binance", account: binance }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(70);
    expect(hs[0]!.token.id).toBeUndefined(); // 没有身份 → 详情页拿不到 id
  });

  it("symbol 归一后再兜底(大小写/空白不影响)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: " usdt ", amount: 50, value: 50, account: binance }),
      row({ symbol: "USDT", amount: 20, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(1);
  });

  it("有 token_id 的行绝不与没有的合并", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, account: binance, tokenId: "tk-usdt" }),
      row({ symbol: "USDT", amount: 20, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
  });
});

// #271:法币持仓(kind="spot")本就走 spot-only 聚合(#129)——无需改 isEligible。isFiat 透传到
// Holding.token(组 = 一个 token → 取代表值),供 hero 的稳定占比按身份判定(不看裸 symbol)。
describe("法币聚合(isFiat)", () => {
  it("法币 spot 行进 holdings、计入净值,并把 isFiat 透传到 Holding.token", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USD",
        amount: 100,
        value: 100,
        platform: "manual",
        account: manual,
        tokenId: "tk-usd",
        isFiat: true,
      }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(100); // 计入净值(subtotal 由调用方对 totalValue 求和)
    expect(hs[0]!.token).toMatchObject({ symbol: "USD", isFiat: true });
  });

  it("同一法币跨账户按 token_id 归一成一行(与加密同源同键)", () => {
    const manual2 = { id: "m2", label: "现金2", connectorId: "manual" };
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USD",
        amount: 100,
        value: 100,
        platform: "manual",
        account: manual,
        tokenId: "tk-usd",
        isFiat: true,
      }),
      row({
        symbol: "USD",
        amount: 40,
        value: 40,
        platform: "manual",
        account: manual2,
        tokenId: "tk-usd",
        isFiat: true,
      }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(140);
    expect(hs[0]!.totalAmount).toBe(140);
    expect(hs[0]!.sources).toHaveLength(2); // 两个账户各一个来源
    expect(hs[0]!.token.isFiat).toBe(true);
  });

  it("非法币行 isFiat 缺省 → Holding.token.isFiat undefined(不误标)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "BTC", amount: 1, value: 65000, account: zerion, tokenId: "tk-btc" }),
    ]);
    expect(hs[0]!.token.isFiat).toBeUndefined();
  });
});
