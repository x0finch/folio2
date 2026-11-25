import { describe, expect, it } from "vitest";
import { decodeCustomConfig, hostOfOrigin, hostProblem } from "../../../src/balance/custom/config";
import fixture from "./fixtures/config.json";

const valid = { ...fixture } as Record<string, unknown>;
const decode = (config: unknown) => decodeCustomConfig(JSON.stringify(config));
const messageOf = (config: unknown): string => {
  const result = decode(config);
  return result.ok ? "" : result.message;
};

describe("decodeCustomConfig", () => {
  it("accepts the fixture config", () => {
    const result = decode(valid);
    expect(result.ok && result.config.host).toBe("api.vault.example");
  });

  it("accepts the minimal shape: host, path, symbol and amount", () => {
    expect(
      decode({ host: "x.example.com", path: "/b", fields: { symbol: "s", amount: "a" } }).ok,
    ).toBe(true);
  });

  it("accepts every auth placement", () => {
    for (const auth of ["none", "bearer", { header: "X-Api-Key" }, { query: "apikey" }]) {
      expect(decode({ ...valid, auth }).ok, JSON.stringify(auth)).toBe(true);
    }
  });

  it("accepts fixed query parameters, with {address} in a value", () => {
    expect(decode({ ...valid, query: { chain: "eth", owner: "{address}" } }).ok).toBe(true);
    // Names that merely contain "token" or "auth" are not keys.
    expect(decode({ ...valid, query: { tokens: "true", author: "x", tokenId: "1" } }).ok).toBe(
      true,
    );
  });

  it.each([
    ["a value with an unknown placeholder", { query: { x: "{page}" } }],
    ["a value with & or =", { query: { x: "a&b=c" } }],
    ["a key-like name", { query: { apikey: "abc123" } }],
    ["a token-like name", { query: { access_token: "abc123" } }],
    ["an auth token", { query: { auth_token: "abc123" } }],
    ["an access key", { query: { access_key: "abc123" } }],
    ["a camelCase token", { query: { apiToken: "abc123" } }],
    ["a dashed key", { query: { "x-api-key": "abc123" } }],
    ["a name the key already uses", { auth: { query: "apikey" }, query: { apikey: "x" } }],
    [
      "a name the pagination already uses",
      { pagination: { type: "page", param: "p" }, query: { p: "1" } },
    ],
    [
      "too many parameters",
      { query: Object.fromEntries([...Array(11)].map((_, i) => [`q${i}`, "1"])) },
    ],
  ])("rejects a query with %s", (_, over) => {
    expect(decode({ ...valid, ...over }).ok).toBe(false);
  });

  it("accepts page pagination in the path or in a param", () => {
    expect(decode({ ...valid, path: "/v1/h/{page}", pagination: { type: "page" } }).ok).toBe(true);
    expect(decode({ ...valid, pagination: { type: "page", param: "p", start: 0 } }).ok).toBe(true);
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown key (a typo)", JSON.stringify({ ...valid, feilds: {} })],
    ["no fields", JSON.stringify({ ...valid, fields: undefined })],
    ["no amount", JSON.stringify({ ...valid, fields: { symbol: "s" } })],
  ])("rejects %s", (_, raw) => {
    expect(decodeCustomConfig(raw).ok).toBe(false);
  });

  it.each([
    ["a scheme", { host: "https://api.vault.example" }],
    ["a port", { host: "api.vault.example:8443" }],
    ["uppercase", { host: "API.vault.example" }],
    ["an IPv4 literal", { host: "127.0.0.1" }],
    ["an IPv6 literal", { host: "[::1]" }],
    ["localhost", { host: "localhost" }],
    ["a .localhost name", { host: "app.localhost" }],
    ["a .local name", { host: "nas.local" }],
    ["a .internal name", { host: "db.internal" }],
    ["a single label", { host: "intranet" }],
    ["a numeric last label", { host: "0x7f.1" }],
    ["a relative path", { path: "v1/holdings" }],
    ["a query in the path", { path: "/v1/holdings?key=abc" }],
    ["a fragment in the path", { path: "/v1/holdings#x" }],
    ["a protocol-relative path", { path: "//evil.example/x" }],
    ["a dot-dot segment", { path: "/v1/../admin" }],
    ["an encoded dot-dot segment", { path: "/v1/%2e%2E/admin" }],
    ["an encoded slash", { path: "/v1/a%2Fb" }],
    ["an unknown placeholder", { path: "/v1/{apiKey}" }],
    ["an unclosed placeholder", { path: "/v1/{address" }],
    ["{page} without page pagination", { path: "/v1/{page}", pagination: undefined }],
    ["page pagination with nowhere to go", { pagination: { type: "page" } }],
    [
      "page in both path and param",
      { path: "/v/{page}", pagination: { type: "page", param: "p" } },
    ],
    ["a cursor without next", { pagination: { type: "cursor", param: "c" } }],
    ["a forbidden key header", { auth: { header: "Host" } }],
    ["the cookie header", { auth: { header: "cookie" } }],
    ["a proxy header", { auth: { header: "X-Forwarded-For" } }],
    ["a malformed header name", { auth: { header: "X Api Key" } }],
    ["key and cursor on one param", { auth: { query: "cursor" } }],
    ["contract without chain", { fields: { symbol: "s", amount: "a", contract: "c" } }],
    ["a malformed dot path", { rows: "data..holdings" }],
  ])("rejects %s", (_, change) => {
    expect(messageOf({ ...valid, ...change })).not.toBe("");
  });

  it("explains the problem in the message", () => {
    expect(messageOf({ ...valid, host: "127.0.0.1" })).toContain("IP literals");
    expect(messageOf({ ...valid, fields: { symbol: "s", amount: "a", contract: "c" } })).toContain(
      "contract needs chain",
    );
  });
});

describe("hostProblem", () => {
  it("passes a public hostname", () => {
    expect(hostProblem("api.vault.example")).toBeUndefined();
    expect(hostProblem("xn--80ak6aa92e.xn--p1ai")).toBeUndefined();
  });

  it("refuses the deployment's own domain and its subdomains", () => {
    expect(hostProblem("folio.example.com", "folio.example.com")).toContain("own domain");
    expect(hostProblem("api.folio.example.com", "folio.example.com")).toContain("own domain");
    expect(hostProblem("example.com", "folio.example.com")).toBeUndefined();
    expect(hostProblem("notfolio.example.com", "folio.example.com")).toBeUndefined();
  });
});

describe("hostOfOrigin", () => {
  it("reads the hostname of an origin, ignoring anything that isn't a URL", () => {
    expect(hostOfOrigin("https://Folio.Example.com:8443/")).toBe("folio.example.com");
    expect(hostOfOrigin("not a url")).toBeUndefined();
    expect(hostOfOrigin(undefined)).toBeUndefined();
  });
});
