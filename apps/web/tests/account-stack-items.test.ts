import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { accountStackItems } from "../src/routes/_authed/-accounts/list-stack-items";

const b = (
  p: Partial<OverviewBalance> & { symbol: string; usdValue: number },
): OverviewBalance => ({
  id: p.symbol,
  amount: 1,
  kind: "spot",
  metaJson: null,
  ...p,
});

// 永续仓位行:coin 与名义敞口都住 meta(#243),而**行的 usdValue 恒为 0** —— 仓位不贡献净值
// (ADR 0010 / #129)。fixture 必须照这个来:第一版编了个非零的 usdValue,于是「用 usdValue 排序」
// 这个真 bug 在单测里全绿(库里 28 条仓位全是 0,真跑起来一格都不显示)。
// `notional` 为负 = 空仓(size 取负,名义值本身在 meta 里是正的,这里用符号表达方向)。
const perp = (coin: string, notional: number, logo?: string): OverviewBalance =>
  b({
    symbol: coin,
    usdValue: 0,
    logo,
    kind: "perp_position",
    id: `perp-${coin}`,
    metaJson: JSON.stringify({
      coin,
      side: notional >= 0 ? "long" : "short",
      entryPx: 1,
      positionValue: notional,
      unrealizedPnl: 0,
      liquidationPx: null,
      marginUsed: 10,
    }),
  });

// DeFi 腿:协议名与协议图住 meta(#126)。
const defi = (protocol: string | null, usdValue: number, protocolLogo?: string): OverviewBalance =>
  b({
    symbol: "aUSDC",
    usdValue,
    kind: "defi",
    id: `defi-${protocol}-${usdValue}`,
    metaJson: JSON.stringify({ ...(protocol ? { protocol } : {}), protocolLogo }),
  });

describe("accountStackItems", () => {
  describe("现货(原有行为不变)", () => {
    it("按 symbol 去重(忽略大小写)并合计价值,保留首见的 symbol/logo", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 100, logo: "eth.png" }),
        b({ symbol: "eth", usdValue: 50 }),
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "ETH", logo: "eth.png", k: "ETH" });
    });

    it("按合计价值降序", () => {
      const items = accountStackItems([
        b({ symbol: "A", usdValue: 10 }),
        b({ symbol: "B", usdValue: 100 }),
        b({ symbol: "C", usdValue: 50 }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["B", "C", "A"]);
    });

    it("过滤掉尘埃代币(无价/空投,< 尘埃阈值)", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 100 }),
        b({ symbol: "SPAM", usdValue: 0 }), // 无价 → 排除
        b({ symbol: "DUST", usdValue: 0.05 }), // < ZERO_DISPLAY_USD($0.10)→ 排除
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("同 symbol 多行合计过阈值则保留(逐行尘埃但合计非零)", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 0.06 }),
        b({ symbol: "eth", usdValue: 0.06 }), // 逐行 < $0.10,合计 0.12 ≥ $0.10 → 保留
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("空 → []", () => {
      expect(accountStackItems([])).toEqual([]);
    });
  });

  describe("永续仓位(#133)", () => {
    it("显示标的币,图来自展示富化", () => {
      const items = accountStackItems([perp("BTC", 900, "btc.png")]);
      expect(items).toEqual([{ name: "BTC", logo: "btc.png", k: "BTC" }]);
    });

    it("**权益行不入叠标** —— 它是抵押物,不是「持有什么」", () => {
      // 权益金额通常比单个仓位大,不排除的话它会排在最前面,把「在交易什么」挤掉。
      const items = accountStackItems([
        perp("ETH", 100),
        b({ symbol: "USDC", usdValue: 5000, kind: "perp_equity" }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("空仓也算一格 —— 名义值取绝对值", () => {
      // 空仓的名义值是负的。按带符号的值排序会把大空仓排到最后、甚至被尘埃阈值滤掉。
      const items = accountStackItems([perp("BTC", -900), perp("ETH", 100)]);
      expect(items.map((i) => i.name)).toEqual(["BTC", "ETH"]);
    });

    it("meta 坏掉的行跳过(不拿空图占一格)", () => {
      const broken = b({ symbol: "??", usdValue: 500, kind: "perp_position", metaJson: "{oops" });
      expect(accountStackItems([broken])).toEqual([]);
    });

    it("同一个币的现货与永续合成一格(并排两个一样的图像 bug)", () => {
      const items = accountStackItems([
        b({ symbol: "BTC", usdValue: 100, logo: "btc.png" }),
        perp("btc", 900),
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "BTC", logo: "btc.png" });
    });
  });

  describe("DeFi(#133)", () => {
    it("按协议一格,图经 /api/logo/defi 代理(客户端零第三方 CDN)", () => {
      const items = accountStackItems([defi("Aave", 500, "https://cdn.example/aave.png")]);
      expect(items).toEqual([{ name: "Aave", logo: "/api/logo/defi/Aave", k: "protocol:Aave" }]);
    });

    it("同协议的多条腿合成一格,金额取绝对值之和", () => {
      // 存 500 / 借 -480 的对冲仓净值只剩 20:按净值它会被排到 ETH 后面,而它其实是这个账户里
      // 最大的一件事。毛敞口口径与 dropEmptyDefiGroups / ADR 0040 一致。
      const items = accountStackItems([
        defi("Aave", 500),
        defi("Aave", -480),
        b({ symbol: "ETH", usdValue: 100 }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["Aave", "ETH"]);
    });

    it("协议名缺失 → 兜底分组,不丢这格", () => {
      const items = accountStackItems([defi(null, 500)]);
      expect(items.map((i) => i.name)).toEqual(["Other"]);
    });

    it("无协议图 → logo 为空(由 <AvatarStack> 回退首字母,不发请求)", () => {
      const items = accountStackItems([defi("Lido", 500)]);
      expect(items[0].logo).toBeUndefined();
    });

    it("协议与同名代币各占一格 —— Aave 这个协议与 AAVE 这个币是两回事", () => {
      const items = accountStackItems([defi("Aave", 500), b({ symbol: "Aave", usdValue: 100 })]);
      expect(items.map((i) => i.k)).toEqual(["protocol:Aave", "AAVE"]);
    });
  });

  it("三类混在一起:各自成格,按量级降序", () => {
    const items = accountStackItems([
      b({ symbol: "ETH", usdValue: 300 }),
      perp("BTC", 900),
      defi("Lido", 500),
      b({ symbol: "USDC", usdValue: 5000, kind: "perp_equity" }), // 抵押物,不入
    ]);
    expect(items.map((i) => i.name)).toEqual(["BTC", "Lido", "ETH"]);
  });
});
