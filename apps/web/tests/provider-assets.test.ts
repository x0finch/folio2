import type { Balance } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { toProviderAssets } from "../src/lib/tokens";

// 这道筛子决定「哪些行去 seed 参考层的孤儿索引」。**放错一行的后果不对称**:
// 少 seed 一个合约,只是那个币暂时没 provider 名/图;多 seed 一个场馆命名(binance/USDC),
// 那些行会卡在无价的孤儿上、不再掉回 symbol 消歧 —— 交易所持仓集体失去价格。
// ADR 0020 第三轮之后判据就是 ref 的形状(`contract:` 标记),不再问平台、不再走 connector 级联。

const bal = (tokenRef: string, symbol = "X"): Balance => ({
  symbol,
  tokenRef,
  amount: 1,
  value: 1,
  kind: "spot",
});

describe("toProviderAssets", () => {
  it("只挑合约形", () => {
    const out = toProviderAssets([
      bal("evm:1/contract:0xa0b8", "USDC"),
      bal("solana/contract:EPjF", "USDC"),
    ]);
    expect(out.map((a) => a.tokenId)).toEqual(["evm:1/contract:0xa0b8", "solana/contract:EPjF"]);
  });

  it("场馆命名不 seed —— 否则那些行会卡在无价的孤儿上", () => {
    expect(toProviderAssets([bal("binance/USDC"), bal("okx/BTC"), bal("hyperliquid/ETH")])).toEqual(
      [],
    );
  });

  it("原生币不 seed(没有合约地址可 seed,它们走 symbol 解析)", () => {
    expect(toProviderAssets([bal("bitcoin/native"), bal("evm:1/native")])).toEqual([]);
  });

  it("`coingecko/<id>` 不 seed —— 它已经是规范 ref", () => {
    expect(toProviderAssets([bal("coingecko/usd-coin")])).toEqual([]);
  });

  it("读不懂的串不 seed,不抛", () => {
    expect(toProviderAssets([bal("nonsense"), bal("a/b/c")])).toEqual([]);
  });

  it("带上 provider 的元信息(name/logo 只在取数瞬时存在,不落快照行)", () => {
    const out = toProviderAssets([
      { ...bal("evm:1/contract:0xa0b8", "USDC"), name: "USD Coin", logo: "p.png" },
    ]);
    expect(out[0]).toEqual({
      tokenId: "evm:1/contract:0xa0b8",
      symbol: "USDC",
      name: "USD Coin",
      logo: "p.png",
    });
  });
});
