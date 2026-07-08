import type { AccountType, ProviderEntry } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { ALL_ENTRIES } from "../src/entries";
import { buildCandidates, resolveActive } from "../src/registry";

// 假 entry 工厂:mechanics 是纯函数,用最小形状喂。
const entry = (id: string, accountType: AccountType, defaultEnabled = true): ProviderEntry => ({
  manifest: { id, accountType, dataSource: id, configSchema: [], defaultEnabled },
  provider: {
    accountType,
    fetchBalances: async () => [],
    validate: async () => true,
  },
});

describe("buildCandidates", () => {
  it("按 accountType 分桶;同 type 多后端进同一桶(方案 A)", () => {
    const c = buildCandidates([
      entry("evm-a", "onchain_evm"),
      entry("evm-b", "onchain_evm", false),
      entry("manual", "manual"),
    ]);
    expect(c.get("onchain_evm")?.map((e) => e.manifest.id)).toEqual(["evm-a", "evm-b"]);
    expect(c.get("manual")).toHaveLength(1);
  });

  it("manifest id 重复 → 抛错(组装 bug 尽早暴露)", () => {
    expect(() => buildCandidates([entry("dup", "manual"), entry("dup", "onchain_evm")])).toThrow(
      /Duplicate provider manifest id/,
    );
  });

  it("manifest 与 provider 的 accountType 不一致 → 抛错", () => {
    const bad = entry("x", "manual");
    (bad.provider as { accountType: AccountType }).accountType = "onchain_evm";
    expect(() => buildCandidates([bad])).toThrow(/accountType mismatch/);
  });
});

describe("resolveActive(本切片:按 manifest 默认)", () => {
  it("每 type 恰一个 defaultEnabled → 生效;defaultEnabled=false 的候选不生效", () => {
    const a = entry("evm-a", "onchain_evm");
    const b = entry("evm-b", "onchain_evm", false);
    const active = resolveActive(buildCandidates([a, b]));
    expect(active.onchain_evm).toBe(a.provider);
    expect(Object.keys(active)).toEqual(["onchain_evm"]);
  });

  it("零个 defaultEnabled → 该 type 缺席(未启用)", () => {
    const active = resolveActive(buildCandidates([entry("evm-b", "onchain_evm", false)]));
    expect(active.onchain_evm).toBeUndefined();
  });

  it("同 type 多个 defaultEnabled → 抛错(声明冲突)", () => {
    expect(() =>
      resolveActive(
        buildCandidates([entry("evm-a", "onchain_evm"), entry("evm-b", "onchain_evm")]),
      ),
    ).toThrow(/Multiple default-enabled/);
  });
});

describe("ALL_ENTRIES(真实组装)", () => {
  it("id 全局唯一、manifest 与 provider type 一致(buildCandidates 不抛)", () => {
    expect(() => buildCandidates(ALL_ENTRIES)).not.toThrow();
  });

  it("覆盖现有全部 9 个 type,且每 type 恰一个默认生效(行为与硬编码 registry 等价)", () => {
    const active = resolveActive(buildCandidates(ALL_ENTRIES));
    expect(Object.keys(active).sort()).toEqual(
      [
        "exchange_binance",
        "exchange_okx",
        "manual",
        "onchain_bitcoin",
        "onchain_cosmos",
        "onchain_evm",
        "onchain_solana",
        "onchain_sui",
        "perp_hyperliquid",
      ].sort(),
    );
  });
});
