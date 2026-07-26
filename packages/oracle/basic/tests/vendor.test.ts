import { describe, expect, it } from "vitest";
import { CGK_VENDOR, cgkRef, vendorIdOf, vendorPartsOf } from "../src";

// 这两个函数是**存储层的边界**:`token_vendor_ids` / `token_price_history` 按 (vendor, vendorId)
// 两列存,写库前要用它们把 tokenRef 拆回两段。
//
// ADR 0020 第三轮之后它们判的是 `opaque` 这一支 —— 只有「厂商命名」才是 (vendor, id);
// 链上合约与原生币都不是,必须拆不出来。
//
// 说清楚这几条测试在保什么:**当下并没有活着的漏洞** —— 唯一会拿合约 ref 走到这里的路径
// (`priceSeries` → 历史价 store)在入口就有 `vendorIdOf(ref, source.id)` 的前置守卫,合约 ref
// 到不了。这里钉的是**这两个函数自己的契约**:它们此前零测试,而这一轮把判据从 `local` 改成
// `opaque`;哪天那道守卫被挪走或换写法,得有东西接着拦,而不是静默拆出一段 `vendor="evm:1"`。

describe("cgkRef", () => {
  it("coin id 规范为小写 kebab,归一在生产者这一侧做", () => {
    expect(cgkRef("USD-Coin")).toBe(`${CGK_VENDOR}/usd-coin`);
  });
});

describe("vendorIdOf", () => {
  it("本厂商命名 → 上游 id", () => {
    expect(vendorIdOf(cgkRef("bitcoin"), CGK_VENDOR)).toBe("bitcoin");
  });

  it("别家厂商命名 → undefined(不张冠李戴)", () => {
    expect(vendorIdOf("coinmarketcap/1", CGK_VENDOR)).toBeUndefined();
  });

  it("链上合约 → undefined —— 它不是任何厂商对这个币的叫法", () => {
    expect(vendorIdOf("evm:1/contract:0xa0b8", CGK_VENDOR)).toBeUndefined();
  });

  it("原生币 → undefined", () => {
    expect(vendorIdOf("bitcoin/native", CGK_VENDOR)).toBeUndefined();
  });

  it("读不懂的串 → undefined,不抛", () => {
    expect(vendorIdOf("nonsense", CGK_VENDOR)).toBeUndefined();
    expect(vendorIdOf("", CGK_VENDOR)).toBeUndefined();
  });
});

describe("vendorPartsOf", () => {
  it("厂商命名 → 存储层的两列", () => {
    expect(vendorPartsOf("coingecko/usd-coin")).toEqual({
      vendor: "coingecko",
      vendorId: "usd-coin",
    });
    // 场馆命名也是 opaque 形 —— 它确实是「binance 管这个币叫 USDC」。
    expect(vendorPartsOf("binance/USDC")).toEqual({ vendor: "binance", vendorId: "USDC" });
  });

  it("链上合约 / 原生币 / 读不懂的 → undefined,调用方据此跳过", () => {
    // #192 到第三轮之间,这里会返回 `{ vendor: "evm:1", vendorId: "0xa0b8" }` —— 一段
    // 语法上成立、语义上胡说的拆分(`evm:1` 不是任何数据源)。
    expect(vendorPartsOf("evm:1/contract:0xa0b8")).toBeUndefined();
    expect(vendorPartsOf("bitcoin/native")).toBeUndefined();
    expect(vendorPartsOf("a/b/c")).toBeUndefined();
  });
});
