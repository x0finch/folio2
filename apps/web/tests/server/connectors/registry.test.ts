import { env } from "cloudflare:test";
import { type ConnectorId, registry as connectorRegistry } from "@folio/connectors";
import { Effect } from "effect";
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

describe("custom source", () => {
  const config = (host: string) =>
    JSON.stringify({ host, path: "/v1/holdings", fields: { symbol: "s", amount: "a" } });

  it("only the config is required; address and key are optional", async () => {
    blockOutbound();
    const { specs } = await realRegistry();
    const byKey = Object.fromEntries((specs.custom ?? []).map((f) => [f.key, f]));
    expect(byKey.config?.optional).toBeUndefined();
    expect(byKey.address?.optional).toBe(true);
    expect(byKey.apiKey).toMatchObject({ type: "secret", optional: true });
  });

  it("the add-account probe checks the config without any request", async () => {
    const outbound = blockOutbound();
    const { validate } = await realRegistry();
    await Effect.runPromise(
      validate("custom", { config: config("api.vault.example"), apiKey: "k" }, { liveness: true }),
    );
    expect(outbound.calls).toEqual([]);
  });

  it("the probe refuses the deployment's own domain", async () => {
    const outbound = blockOutbound();
    const e = env as unknown as Record<string, string | undefined>;
    const before = e.BETTER_AUTH_URL;
    e.BETTER_AUTH_URL = "https://folio.example.com";
    try {
      const { validate } = await realRegistry();
      const probe = (host: string) =>
        Effect.runPromiseExit(validate("custom", { config: config(host) }, { liveness: true }));
      expect((await probe("folio.example.com"))._tag).toBe("Failure");
      expect((await probe("api.vault.example"))._tag).toBe("Success");
      expect(outbound.calls).toEqual([]);
    } finally {
      e.BETTER_AUTH_URL = before;
    }
  });

  it("a keyed config needs the key on add; an unkeyed one doesn't", async () => {
    blockOutbound();
    const { validate } = await realRegistry();
    const keyed = JSON.stringify({
      host: "api.vault.example",
      path: "/v1/holdings",
      auth: "bearer",
      fields: { symbol: "s", amount: "a" },
    });
    const error = await Effect.runPromise(Effect.flip(validate("custom", { config: keyed })));
    expect(error.message).toBe("API Key: required by this config");
    await Effect.runPromise(validate("custom", { config: config("api.vault.example") }));
  });

  it("a private host fails the shape check with the reason", async () => {
    blockOutbound();
    const { validate } = await realRegistry();
    const error = await Effect.runPromise(
      Effect.flip(validate("custom", { config: config("db.internal") }, { liveness: true })),
    );
    expect(error.message).toContain("private network names");
  });
});
