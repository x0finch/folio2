import { type ConnectorId, registry as connectorRegistry } from "@folio/connectors";
import { describe, expect, it } from "vitest";
import { realRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";

// The listConnectors / getConnectorCredentialSpecs handlers are one-line forwards inlined in a file
// that can't load in this harness (`createServerFn`), so test what they forward: catalog and specs.
describe("connector catalog (what listConnectors returns)", () => {
  it("every registered connector is in the catalog with a display name", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid] of connectorRegistry) {
      expect(catalog[cid], `${cid} missing from catalog`).toBeDefined();
      expect(catalog[cid].label, `${cid} has no display name`).toBeTruthy();
    }
  });

  it("no display name equals the bare connectorId (a missing config)", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid, entry] of Object.entries(catalog)) {
      expect(entry.label, `${cid} display name is just its id`).not.toBe(cid);
    }
  });

  it("every connector has a logo path", async () => {
    blockOutbound();
    const { catalog } = await realRegistry();

    for (const [cid, entry] of Object.entries(catalog)) {
      expect(entry.logo, `${cid} has no logo`).toBeTruthy();
    }
  });
});

describe("credential field specs (what getConnectorCredentialSpecs returns)", () => {
  it("OKX has a passphrase, binance doesn't", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    expect(specs.okx?.map((f) => f.key)).toContain("passphrase");
    expect(specs.binance?.map((f) => f.key)).not.toContain("passphrase");
  });

  it("CEX secret fields are typed secret, not public", async () => {
    // `sealCreds` encrypts by field type; a mistyped field would be stored as plaintext.
    blockOutbound();
    const { specs } = await realRegistry();

    const secretish = (cid: ConnectorId) =>
      (specs[cid] ?? []).filter((f) => /secret|passphrase/i.test(f.key));
    for (const cid of ["binance", "okx", "bybit"] as const) {
      const fields = secretish(cid);
      expect(fields.length, `${cid} has no secret fields?`).toBeGreaterThan(0);
      for (const f of fields) expect(f.type, `${cid}.${f.key}`).toBe("secret");
    }
  });

  it("every field has a label (used as the form's i18n key)", async () => {
    blockOutbound();
    const { specs } = await realRegistry();

    for (const [cid, fields] of Object.entries(specs)) {
      for (const f of fields ?? []) {
        expect(f.label, `${cid}.${f.key} has no label`).toBeTruthy();
      }
    }
  });

  it("specs contain nothing unserializable like validators (they're sent to the client)", async () => {
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
