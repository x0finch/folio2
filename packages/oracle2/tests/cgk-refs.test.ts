import type { AssetPlatform, CoinListItem } from "@folio/coingecko-client";
import { describe, expect, it } from "vitest";
import { createCgkRefs } from "../src/cgk-refs";
import { NON_EVM_PLATFORMS } from "../src/coingecko/platform-slugs";
import { toCgkRefRows } from "../src/coingecko/ref-map";
import { fakeCgkRefStore, fakeSource } from "./fakes";
import assetPlatforms from "./fixtures/asset-platforms.json" with { type: "json" };
import coinsList from "./fixtures/coins-list.json" with { type: "json" };

const COINS = coinsList as CoinListItem[];
const PLATFORMS = assetPlatforms as AssetPlatform[];

describe("toCgkRefRows —— 纯转换(golden)", () => {
  const result = toCgkRefRows(COINS, PLATFORMS);
  const byRef = new Map(result.rows.map((r) => [r.ref, r.coinId]));

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

  it("原生币不产行", () => {
    // bitcoin 的 platforms 是 `{"": ""}`、ethereum 是 `{}` —— 它们靠 symbol 认。
    expect(result.rows.some((r) => r.coinId === "bitcoin")).toBe(false);
    expect(result.rows.some((r) => r.coinId === "ethereum")).toBe(false);
  });

  it("不追踪的链只计数,不产行、不告警(CoinGecko 有两百来条)", () => {
    expect(result.rows.some((r) => r.ref.startsWith("tron/"))).toBe(false);
    expect(result.skipped).toBe(1); // usd-coin 的 tron 那条
    expect(result.unmatchedPlatforms).toEqual([]);
  });

  it("残缺条目一律跳过:没 id 的币、null / 空白地址、没有 platforms 键", () => {
    expect(byRef.has("evm:1/0xbeef")).toBe(false);
    expect(result.rows.some((r) => r.coinId === "null-address")).toBe(false);
    expect(result.rows.some((r) => r.coinId === "no-platforms-key")).toBe(false);
  });

  it("整份行数钉死(golden)", () => {
    expect(result.rows).toHaveLength(6);
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

describe("对照失配", () => {
  it("我们指名要的非 EVM 链在平台表里没了 → 报出来,不静默", () => {
    // CoinGecko 把 sui 那条平台改名成 sui-network 的情形:平台表和币目录一起换了词。
    const renamed = PLATFORMS.map((p) => (p.id === "sui" ? { ...p, id: "sui-network" } : p));
    const coins = COINS.map((c) =>
      c.platforms?.sui ? { ...c, platforms: { "sui-network": c.platforms.sui } } : c,
    );
    const result = toCgkRefRows(coins, renamed);

    expect(result.unmatchedPlatforms).toEqual(["sui"]);
    // 这条链的币确实一行都没有了 —— 不喊出来的话,它就这么静默地没价没图。
    expect(result.rows.some((r) => r.ref.startsWith("sui"))).toBe(false);
  });

  it("对照表里的每条链都是「我们的命名者 → CoinGecko 的 id」", () => {
    // 三条恰好同名纯属运气,写下来是为了改了能被上面那条测试抓到。
    expect(NON_EVM_PLATFORMS).toEqual({ solana: "solana", sui: "sui", cosmos: "cosmos" });
  });
});

describe("refresh —— cron 调用点", () => {
  it("拉 → 转换 → 一次整份灌;之后 lookup 就能命中", async () => {
    const store = fakeCgkRefStore();
    const source = fakeSource();
    source.refMap = {
      rows: toCgkRefRows(COINS, PLATFORMS).rows,
      unmatchedPlatforms: [],
      skipped: 0,
    };
    const cgkRefs = createCgkRefs({ store, source });

    expect(await cgkRefs.refreshedAt()).toBeNull();
    const summary = await cgkRefs.refresh(1_700_000_000_000);

    expect(summary.rows).toHaveLength(6);
    expect(store.writes).toBe(1); // 一次整份写
    expect(await cgkRefs.refreshedAt()).toBe(1_700_000_000_000);
    expect((await cgkRefs.lookup(["cosmos/uatom"])).get("cosmos/uatom")).toBe("cosmos");
  });

  it("失配经 onWarn 报出;没有失配就不吵", async () => {
    const warns: { message: string; meta: Record<string, unknown> }[] = [];
    const source = fakeSource();
    source.refMap = { rows: [], unmatchedPlatforms: ["sui"], skipped: 0 };
    const noisy = createCgkRefs({
      store: fakeCgkRefStore(),
      source,
      onWarn: (message, meta) => warns.push({ message, meta }),
    });
    await noisy.refresh(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.meta).toEqual({ platforms: ["sui"] });

    source.refMap = { rows: [], unmatchedPlatforms: [], skipped: 0 };
    await noisy.refresh(2);
    expect(warns).toHaveLength(1);
  });

  it("空批不查库", async () => {
    const store = fakeCgkRefStore();
    let lookups = 0;
    const counting = {
      ...store,
      lookup: async (r: readonly string[]) => (lookups++, store.lookup(r)),
    };
    await createCgkRefs({ store: counting, source: fakeSource() }).lookup([]);
    expect(lookups).toBe(0);
  });
});
