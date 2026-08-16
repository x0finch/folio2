import { describe, expect, it } from "vitest";
import { connectorLabelFallback } from "../src/lib/core/logo";

// 目录还没到位那一帧显什么(#467)。原来显的是裸 id —— `hyperliquid` / `okx` 印在界面上,
// 十行一起闪一下,像数据坏了。
//
// **这些期望值要与 manifest 的 `label` 一致**(权威在那边):Binance / Bitcoin / Bybit / EVM /
// Hyperliquid / OKX / Manual / Solana / Sui / Cosmos。对不上只影响那一帧,但那正是这个函数存在的理由。
describe("connectorLabelFallback", () => {
  it("首字母大写", () => {
    expect(connectorLabelFallback("hyperliquid")).toBe("Hyperliquid");
    expect(connectorLabelFallback("bitcoin")).toBe("Bitcoin");
    expect(connectorLabelFallback("binance")).toBe("Binance");
    expect(connectorLabelFallback("bybit")).toBe("Bybit");
    expect(connectorLabelFallback("manual")).toBe("Manual");
    expect(connectorLabelFallback("solana")).toBe("Solana");
    expect(connectorLabelFallback("cosmos")).toBe("Cosmos");
  });

  it("**缩写不是首字母大写** —— 这两个照 manifest 写死", () => {
    expect(connectorLabelFallback("evm")).toBe("EVM");
    expect(connectorLabelFallback("okx")).toBe("OKX");
  });

  it("三个字母的**不都是**缩写 —— 所以不能用「短就全大写」的规则", () => {
    // `sui` 的 manifest 名就是 "Sui"。这条钉住那个诱人但错的启发式。
    expect(connectorLabelFallback("sui")).toBe("Sui");
  });

  it("没见过的 id 也不露出小写内部名", () => {
    expect(connectorLabelFallback("newvenue")).toBe("Newvenue");
  });

  it("空串原样返回(不炸)", () => {
    expect(connectorLabelFallback("")).toBe("");
  });
});
