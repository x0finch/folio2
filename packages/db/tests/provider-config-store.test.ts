import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createProviderConfigStore } from "../src";
import { getDb } from "../src/client";
import { providerConfig } from "../src/schema";

// pool 不隔离每测试存储 → 每测试前清空。
beforeEach(async () => {
  await getDb(env).delete(providerConfig);
});

const store = () => createProviderConfigStore(env);

describe("providerConfigStore(纯覆盖表:空表 = manifest 默认)", () => {
  it("空表 getAll → [](零覆盖,一切默认)", async () => {
    expect(await store().getAll()).toEqual([]);
  });

  it("enable:写入选中行;settings 一并写(sealed JSON 不透明存取)", async () => {
    await store().enable("evm-zerion", "onchain_evm", '{"apiKey":"sealed"}');
    const rows = await store().getAll();
    expect(rows).toEqual([
      {
        providerId: "evm-zerion",
        accountType: "onchain_evm",
        enabled: true,
        settings: '{"apiKey":"sealed"}',
      },
    ]);
  });

  it("enable 不带 settings:不覆写已存的 settings(重启用无需重填)", async () => {
    await store().putSettings("evm-zerion", "onchain_evm", '{"apiKey":"s1"}');
    await store().enable("evm-zerion", "onchain_evm");
    const [row] = await store().getAll();
    expect(row.enabled).toBe(true);
    expect(row.settings).toBe('{"apiKey":"s1"}');
  });

  it("enable = 该 type 的原子切换:同 type 其它 true 行退位为 false(每 type 至多一条 true)", async () => {
    await store().enable("evm-a", "onchain_evm");
    await store().enable("evm-b", "onchain_evm");
    const rows = await store().getAll();
    expect(rows.find((r) => r.providerId === "evm-a")?.enabled).toBe(false);
    expect(rows.find((r) => r.providerId === "evm-b")?.enabled).toBe(true);
    // 异 type 不受影响
    await store().enable("solana-x", "onchain_solana");
    expect((await store().getAll()).find((r) => r.providerId === "evm-b")?.enabled).toBe(true);
  });

  it("disable:显式停用、保留 settings", async () => {
    await store().enable("evm-a", "onchain_evm", '{"apiKey":"s"}');
    await store().disable("evm-a", "onchain_evm");
    const [row] = await store().getAll();
    expect(row.enabled).toBe(false);
    expect(row.settings).toBe('{"apiKey":"s"}');
  });

  it("putSettings 对无行 provider:插入 enabled=NULL(只存 settings,不覆盖启停)", async () => {
    await store().putSettings("evm-a", "onchain_evm", '{"apiKey":"s"}');
    const [row] = await store().getAll();
    expect(row.enabled).toBeNull();
    expect(row.settings).toBe('{"apiKey":"s"}');
    // null = 清除自定义、回落默认
    await store().putSettings("evm-a", "onchain_evm", null);
    expect((await store().getAll())[0].settings).toBeNull();
  });
});
