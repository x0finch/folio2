import type { AccountType, ProviderEntry, ProviderManifest } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { ALL_ENTRIES } from "../src/entries";
import { buildCandidates, resolveActive, resolveSettings } from "../src/registry";

// 假 entry 工厂:mechanics 是纯函数,用最小形状喂。
const entry = (id: string, accountType: AccountType, defaultEnabled = true): ProviderEntry => ({
  manifest: { id, accountType, dataSource: id, configSchema: [], defaultEnabled },
  create: () => ({
    accountType,
    fetchBalances: async () => [],
    validate: async () => true,
  }),
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
});

describe("resolveActive(启用 = 覆盖 ?? manifest 默认)", () => {
  const a = entry("evm-a", "onchain_evm");
  const b = entry("evm-b", "onchain_evm", false);

  it("无覆盖:恰一个 defaultEnabled → 生效;false 默认的候选不生效", () => {
    const active = resolveActive(buildCandidates([a, b]));
    expect(active.onchain_evm).toBe(a);
    expect(Object.keys(active)).toEqual(["onchain_evm"]);
  });

  it("enabled=true 覆盖 = 选中:压过 manifest 默认(切换后端)", () => {
    const active = resolveActive(buildCandidates([a, b]), new Map([["evm-b", true]]));
    expect(active.onchain_evm).toBe(b);
  });

  it("enabled=false 覆盖:显式停用默认者 → 该 type 缺席(关闭类型)", () => {
    const active = resolveActive(buildCandidates([a, b]), new Map([["evm-a", false]]));
    expect(active.onchain_evm).toBeUndefined();
  });

  it("enabled=null(仅存 settings 的行)不影响启停", () => {
    const active = resolveActive(buildCandidates([a, b]), new Map([["evm-a", null]]));
    expect(active.onchain_evm).toBe(a);
  });

  it("零个 defaultEnabled 且无覆盖 → 缺席(defaultEnabled=false 的冷门 provider)", () => {
    const active = resolveActive(buildCandidates([b]));
    expect(active.onchain_evm).toBeUndefined();
    // 启用覆盖后生效
    expect(resolveActive(buildCandidates([b]), new Map([["evm-b", true]])).onchain_evm).toBe(b);
  });

  it("同 type 多条 true 覆盖 → 抛错(store 不变量被破坏)", () => {
    expect(() =>
      resolveActive(
        buildCandidates([a, b]),
        new Map([
          ["evm-a", true],
          ["evm-b", true],
        ]),
      ),
    ).toThrow(/Multiple enabled/);
  });

  it("同 type 多个 defaultEnabled → 抛错(manifest 声明冲突)", () => {
    expect(() =>
      resolveActive(
        buildCandidates([entry("evm-a", "onchain_evm"), entry("evm-c", "onchain_evm")]),
      ),
    ).toThrow(/Multiple default-enabled/);
  });
});

describe("resolveSettings(分层:自定义 → envDefaults 槽 → 缺失)", () => {
  const manifest: ProviderManifest = {
    id: "evm-x",
    accountType: "onchain_evm",
    dataSource: "x",
    configSchema: [
      { key: "apiKey", type: "secret", label: "API Key", validator: { "~standard": {} } as never },
    ],
    envDefaults: { apiKey: "X_API_KEY" },
    defaultEnabled: true,
  };

  it("自定义值优先于 env 默认", () => {
    expect(resolveSettings(manifest, { apiKey: "custom" }, { X_API_KEY: "env" })).toEqual({
      apiKey: "custom",
    });
  });

  it("无自定义 → 落到 envDefaults 声明的部署时默认", () => {
    expect(resolveSettings(manifest, undefined, { X_API_KEY: "env" })).toEqual({ apiKey: "env" });
  });

  it("都没有 → 字段缺失(生效判定由上层做)", () => {
    expect(resolveSettings(manifest, undefined, {})).toEqual({});
  });

  it("只解析 configSchema 声明的字段(不透传杂键)", () => {
    expect(resolveSettings(manifest, { apiKey: "c", junk: "x" }, {})).toEqual({ apiKey: "c" });
  });
});

describe("ALL_ENTRIES(真实组装)", () => {
  it("id 全局唯一(buildCandidates 不抛)", () => {
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

  it("manifest 与工厂产物的 accountType 一致", () => {
    for (const e of ALL_ENTRIES) {
      expect(e.create().accountType).toBe(e.manifest.accountType);
    }
  });
});
