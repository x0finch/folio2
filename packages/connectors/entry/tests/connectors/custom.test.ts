import { validateCredentials } from "@folio/connectors-basic";
import { customBalance } from "@folio/upstreams";
import { describe, expect, it } from "vitest";
import { custom } from "../../src/connectors/custom";
import { getConnector, registry } from "../../src/registry";

const config = (host = "api.vault.example", auth = "bearer") =>
  JSON.stringify({ host, path: "/v1/holdings", auth, fields: { symbol: "s", amount: "a" } });

const creds = custom.account.creds;
const keepsSecrets = (previous: string, next: string) =>
  custom.account.keepsSecrets?.({ config: previous }, { config: next });

describe("custom account kind", () => {
  it("is registered, marked to market and served by the custom upstream", () => {
    const manifest = getConnector(registry, "custom");
    expect(manifest?.valuation).toBe("mark-to-market");
    expect(manifest?.balance.providers).toEqual([customBalance]);
    // Inline, so the logo proxy never fetches anything for it.
    expect(manifest?.logo.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("decodes the config on save; address and key are optional", async () => {
    const out = await validateCredentials(creds, { config: config() });
    expect(out.config).toMatchObject({ host: "api.vault.example" });
    expect(out.apiKey).toBeUndefined();
    expect(out.address).toBeUndefined();
  });

  it("refuses a key that can't travel in a header", async () => {
    for (const apiKey of ["abc def", "clé", "a\u200bb"]) {
      await expect(validateCredentials(creds, { config: config(), apiKey })).rejects.toThrow(
        /apiKey/,
      );
    }
    await expect(
      validateCredentials(creds, { config: config(), apiKey: "sk-live_A1.b2~" }),
    ).resolves.toMatchObject({ apiKey: "sk-live_A1.b2~" });
  });

  it("needs the key for a keyed config and the address for an {address} config", () => {
    const needs = (c: object) =>
      custom.account.needs?.({
        config: JSON.stringify({
          path: "/v1/h",
          fields: { symbol: "s", amount: "a" },
          ...c,
          host: "api.x.example",
        }),
      });
    expect(needs({})).toEqual([]);
    expect(needs({ auth: "bearer" })).toEqual(["apiKey"]);
    expect(needs({ path: "/v1/{address}" })).toEqual(["address"]);
    expect(needs({ query: { owner: "{address}" }, auth: { header: "X-Key" } })).toEqual([
      "apiKey",
      "address",
    ]);
  });

  it("refuses an address made only of dots", async () => {
    await expect(validateCredentials(creds, { config: config(), address: ".." })).rejects.toThrow(
      /address/,
    );
  });

  it("rejects a bad config with the reason", async () => {
    await expect(validateCredentials(creds, { config: config("127.0.0.1") })).rejects.toThrow(
      /config: IP literals/,
    );
    await expect(validateCredentials(creds, { config: "{" })).rejects.toThrow(/config/);
    await expect(validateCredentials(creds, {})).rejects.toThrow(/config/);
  });

  it("keeps the key while the host stays and it sends one; drops it otherwise", () => {
    const moved = JSON.stringify({ ...JSON.parse(config()), path: "/v2/holdings" });
    expect(keepsSecrets(config(), moved)).toBe(true);
    expect(keepsSecrets(config(), config("api.other.example"))).toBe(false);
    expect(keepsSecrets(config(), config(undefined, "none"))).toBe(false);
    expect(keepsSecrets("not json", config())).toBe(false);
  });
});
