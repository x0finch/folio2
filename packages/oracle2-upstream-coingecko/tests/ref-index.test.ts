import type { AssetPlatform, CoinListItem } from "@folio/coingecko-client";
import { describe, expect, it } from "vitest";
import { NON_EVM_PLATFORMS, toRefIndexRows, UPSTREAM_ID } from "../src";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };
import coinsList from "./fixtures/coins-list.json" with { type: "json" };

const COINS = coinsList as CoinListItem[];
const PLATFORMS = assetPlatforms as AssetPlatform[];

// 「两个端点 → 全局映射行」的纯转换住在 adapter 里(ADR 0023):契约层不知道上游有几个端点、
// 返回什么形状。响应几 MB、四万来行,出错在生产上是「某条链的币全部没价没图」且不报错 →
// 必须 fixture 钉死。
describe("toRefIndexRows —— 纯转换(golden)", () => {
  const result = toRefIndexRows(COINS, PLATFORMS);
  const byRef = new Map(result.rows.map((r) => [r.ref, r.localName]));

  it("每一行的 namer 都是本 adapter 的 id", () => {
    expect(new Set(result.rows.map((r) => r.namer))).toEqual(new Set([UPSTREAM_ID]));
  });

  it("EVM 平台翻成 evm:<chainId>,地址小写归一", () => {
    expect(byRef.get("evm:1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe("usd-coin");
    expect(byRef.get("evm:42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831")).toBe("usd-coin");
    expect(byRef.get("evm:8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBe("usd-coin");
  });

  it("非 EVM 走显式对照,地址原样保留(base58 / bech32 大小写敏感)", () => {
    expect(byRef.get("solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("usd-coin");
    expect(byRef.get("cosmos/uatom")).toBe("cosmos");
    expect(byRef.get("sui/0xSuiTokenAddress00000000000000000000000000AB")).toBe("suicoin");
  });

  it("原生币不产行(它们的 platforms 字典是空的,靠 symbol 认)", () => {
    expect(result.rows.some((r) => r.localName === "bitcoin")).toBe(false);
    expect(result.rows.some((r) => r.localName === "ethereum")).toBe(false);
  });

  it("不追踪的链只计数,不产行、不告警(CoinGecko 有两百来条)", () => {
    expect(result.rows.some((r) => r.ref.startsWith("tron/"))).toBe(false);
    expect(result.skipped).toBe(1); // usd-coin 的 tron 那条
    expect(result.unmatchedPlatforms).toEqual([]);
  });

  it("残缺条目一律跳过:没 id 的币、null / 空白地址、没有 platforms 键", () => {
    expect(byRef.has("evm:1/0xbeef")).toBe(false);
    expect(result.rows.some((r) => r.localName === "null-address")).toBe(false);
    expect(result.rows.some((r) => r.localName === "no-platforms-key")).toBe(false);
  });

  it("整份行数与键钉死(golden)", () => {
    expect([...byRef.keys()].sort()).toEqual([
      "cosmos/uatom",
      "evm:1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "evm:42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "evm:8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "sui/0xSuiTokenAddress00000000000000000000000000AB",
    ]);
  });
});

describe("链对照失配", () => {
  it("我们指名要的非 EVM 链在平台表里没了 → 报出来,不静默", () => {
    // CoinGecko 把 sui 那条平台改名成 sui-network 的情形:平台表和币目录一起换了词。
    const renamed = PLATFORMS.map((p) => (p.id === "sui" ? { ...p, id: "sui-network" } : p));
    const coins = COINS.map((c) =>
      c.platforms?.sui ? { ...c, platforms: { "sui-network": c.platforms.sui } } : c,
    );
    const result = toRefIndexRows(coins, renamed);

    expect(result.unmatchedPlatforms).toEqual(["sui"]);
    // 这条链的币确实一行都没有了 —— 不喊出来的话,它就这么静默地没价没图。
    expect(result.rows.some((r) => r.ref.startsWith("sui"))).toBe(false);
  });

  it("对照表是「我们的命名者 → CoinGecko 的 id」,三条恰好同名纯属运气", () => {
    // 写下来是为了改了能被上面那条测试抓到。
    expect(NON_EVM_PLATFORMS).toEqual({ solana: "solana", sui: "sui", cosmos: "cosmos" });
  });
});
