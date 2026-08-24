import { type ConnectorId, registry as connectorRegistry } from "@folio/connectors";
import { describe, expect, it } from "vitest";
import { realRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";

// #527 · listConnectors / getConnectorCredentialSpecs
//
// **这两个 server fn 的 handler 是内联在 `connectors/index.ts` 里的**(它们各只有一行:从门票上
// 取一个字段),而那个文件 import 不进这套 harness —— 它有 `createServerFn`,那条链要 TanStack
// Start 的 server 入口(探针实测)。
//
// 所以这里测的是**同一份东西的产地**:`ConnectorRegistry` 的 `catalog` 与 `specs`。那一行转发没有
// 分支可测,而这两份数据有 —— 少配一个展示名、字段 type 写错,都会在界面上现形。
// CODING.md 那条「别造无逻辑的转发」反过来也成立:无逻辑的转发不必单独测,该测它转发的东西。
describe("connector 目录(listConnectors 发的就是它)", () => {
  it("每个注册的 connector 都在目录里,而且有展示名", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid] of connectorRegistry) {
      expect(catalog[cid], `${cid} 不在目录里`).toBeDefined();
      expect(catalog[cid].label, `${cid} 没有展示名`).toBeTruthy();
    }
  });

  it("没有哪个展示名等于裸 connectorId —— 那是「忘了配」的样子", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid, entry] of Object.entries(catalog)) {
      expect(entry.label, `${cid} 的展示名就是 id 本身`).not.toBe(cid);
    }
  });

  it("每个 connector 都有 logo 路径", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid, entry] of Object.entries(catalog)) {
      expect(entry.logo, `${cid} 没有 logo`).toBeTruthy();
    }
  });

  it("目录不带任何用户数据 —— 两次取到的完全一样", async () => {
    blockOutbound();
    const a = await realRegistry();
    const b = await realRegistry();

    expect(a.catalog).toEqual(b.catalog);
  });
});

describe("凭据字段规格(getConnectorCredentialSpecs 发的就是它)", () => {
  it("OKX 有 passphrase,binance 没有", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    expect(specs.okx?.map((f) => f.key)).toContain("passphrase");
    expect(specs.binance?.map((f) => f.key)).not.toContain("passphrase");
  });

  it("每个字段的 type 都在三档之内 —— 加密塑形全靠它", async () => {
    // **这条是红线的上游。** `sealCreds` 按 type 决定加不加密;出现一个界外的 type,
    // 那个字段会被当成明文落库。
    blockOutbound();
    const { specs } = await realRegistry();

    for (const [cid, fields] of Object.entries(specs)) {
      for (const f of fields ?? []) {
        expect(["public", "semi", "secret"], `${cid}.${f.key} 的 type 越界`).toContain(f.type);
      }
    }
  });

  it("CEX 的 secret 字段确实标成 secret,不是 public", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    const secretish = (cid: ConnectorId) =>
      (specs[cid] ?? []).filter((f) => /secret|passphrase/i.test(f.key));
    for (const cid of ["binance", "okx", "bybit"] as const) {
      const fields = secretish(cid);
      expect(fields.length, `${cid} 一个 secret 字段都没有?`).toBeGreaterThan(0);
      for (const f of fields) expect(f.type, `${cid}.${f.key}`).toBe("secret");
    }
  });

  it("每个字段都有 label(表单要拿它当 i18n key)", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    for (const [cid, fields] of Object.entries(specs)) {
      for (const f of fields ?? []) {
        expect(f.label, `${cid}.${f.key} 没有 label`).toBeTruthy();
      }
    }
  });

  it("规格里不含 validator 那种不可序列化的东西 —— 它要发到客户端", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    expect(() => JSON.stringify(specs)).not.toThrow();
    for (const fields of Object.values(specs)) {
      for (const f of fields ?? []) {
        expect(Object.keys(f).sort()).toEqual(expect.arrayContaining(["key", "label", "type"]));
        expect(Object.keys(f)).not.toContain("validator");
      }
    }
  });
});
