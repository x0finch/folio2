import type { AccountType, ProviderEntry } from "@folio/balances";
import type { ProviderConfigRow } from "@folio/db";
import { describe, expect, it } from "vitest";
import { buildProviderStatusView } from "../src/lib/provider-status";

// 视图组装纯测:三态(可用/待配置/未启用)+ 默认/自定义 key 的存在性投影(值绝不出现)。
const entry = (
  id: string,
  accountType: AccountType,
  opts: { defaultEnabled?: boolean; withKey?: boolean; envName?: string } = {},
): ProviderEntry => ({
  manifest: {
    id,
    accountType,
    dataSource: id,
    configSchema: opts.withKey
      ? [{ key: "apiKey", type: "secret", label: "API Key", validator: {} as never }]
      : [],
    ...(opts.envName ? { envDefaults: { apiKey: opts.envName } } : {}),
    defaultEnabled: opts.defaultEnabled ?? true,
  },
  create: () => ({ accountType, fetchBalances: async () => [], validateAccount: async () => true }),
});

const row = (providerId: string, over: Partial<ProviderConfigRow> = {}): ProviderConfigRow => ({
  providerId,
  accountType: "onchain_evm",
  enabled: null,
  settings: null,
  ...over,
});

const candidatesOf = (...entries: ProviderEntry[]) => {
  const m = new Map<AccountType, ProviderEntry[]>();
  for (const e of entries) {
    const list = m.get(e.manifest.accountType) ?? [];
    list.push(e);
    m.set(e.manifest.accountType, list);
  }
  return m;
};

describe("buildProviderStatusView", () => {
  it("无设置字段的默认 provider → active + configured(开箱即用)", () => {
    const [v] = buildProviderStatusView(candidatesOf(entry("manual", "manual")), [], () => false);
    expect(v.activeId).toBe("manual");
    expect(v.configured).toBe(true);
  });

  it("要 key 的 provider:env 槽有值 → configured;无值且无自定义 → 待配置", () => {
    const e = entry("evm-z", "onchain_evm", { withKey: true, envName: "Z_KEY" });
    const withEnv = buildProviderStatusView(candidatesOf(e), [], (n) => n === "Z_KEY")[0];
    expect(withEnv.configured).toBe(true);
    expect(withEnv.candidates[0].hasEnvDefault).toBe(true);

    const noEnv = buildProviderStatusView(candidatesOf(e), [], () => false)[0];
    expect(noEnv.activeId).toBe("evm-z");
    expect(noEnv.configured).toBe(false);
  });

  it("存过自定义 settings → configured(即使 env 无值);只投影存在性,不带值", () => {
    const e = entry("evm-z", "onchain_evm", { withKey: true });
    const rows = [row("evm-z", { settings: '{"apiKey":"SEALED"}' })];
    const [v] = buildProviderStatusView(candidatesOf(e), rows, () => false);
    expect(v.configured).toBe(true);
    expect(v.candidates[0].hasCustomSettings).toBe(true);
    expect(JSON.stringify(v)).not.toContain("SEALED");
  });

  it("enabled=true 覆盖 = 选中(压过默认);enabled=false 停默认 → 未启用", () => {
    const a = entry("evm-a", "onchain_evm");
    const b = entry("evm-b", "onchain_evm", { defaultEnabled: false });
    const switched = buildProviderStatusView(
      candidatesOf(a, b),
      [row("evm-b", { enabled: true })],
      () => false,
    )[0];
    expect(switched.activeId).toBe("evm-b");

    const off = buildProviderStatusView(
      candidatesOf(a, b),
      [row("evm-a", { enabled: false })],
      () => false,
    )[0];
    expect(off.activeId).toBeNull();
  });
});
