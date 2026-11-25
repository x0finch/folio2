import type { UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type CustomConfig, decodeCustomConfig } from "../../../src/balance/custom/config";
import { MAX_BODY_BYTES, MAX_PAGES } from "../../../src/balance/custom/constants";
import { customBalance } from "../../../src/balance/custom/upstream";
import {
  type HttpClientRequestLike,
  httpStub,
  jsonResponse as json,
  runClient,
} from "../../../src/runtime/testing";
import { expectNoSecret, recorder, safeJson } from "../../contract/contract";
import fixture from "./fixtures/config.json";
import page1 from "./fixtures/holdings-page-1.json";
import page2 from "./fixtures/holdings-page-2.json";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "vault-key-123";
const OWN = { BETTER_AUTH_URL: "https://folio.example.com" };

const configOf = (change: Record<string, unknown> = {}): CustomConfig => {
  const result = decodeCustomConfig(JSON.stringify({ ...fixture, ...change }));
  if (!result.ok) throw new Error(result.message);
  return result.config;
};

type Ctx = Parameters<typeof customBalance.fetchBalances>[0];
const ctx = (
  creds: Record<string, unknown> = { config: configOf(), apiKey: KEY, address: ADDRESS },
  env: Record<string, string> = OWN,
): Ctx =>
  ({ account: { id: "a1", label: "Vault", connectorId: "custom", creds }, creds: env }) as Ctx;

// Cursor pagination over the two fixture pages.
const pages = ({ url }: HttpClientRequestLike) =>
  json(url.searchParams.get("cursor") === "c2" ? page2 : page1);

const run = <A, E>(
  reply: (request: HttpClientRequestLike, nth: number) => Response,
  effect: Effect.Effect<A, E, UpstreamNeeds>,
) => {
  const stub = httpStub(reply);
  return runClient(stub, effect, "none").then((value) => ({ value, calls: stub.calls }));
};
const failing = (
  reply: (request: HttpClientRequestLike, nth: number) => Response,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
) => run(reply, Effect.flip(effect));

describe("fetchBalances", () => {
  it("follows the cursor to the last page and fills the path from the account", async () => {
    const { value, calls } = await run(pages, customBalance.fetchBalances(ctx()));
    expect(value.balances.map((b) => b.symbol)).toEqual(["ETH", "USDC", "PTS", "SOL"]);
    expect(value.note).toBeUndefined();
    expect(calls.map((c) => c.request.url.href)).toEqual([
      `https://api.vault.example/v1/wallets/${ADDRESS}/holdings`,
      `https://api.vault.example/v1/wallets/${ADDRESS}/holdings?cursor=c2`,
    ]);
    expect(calls.every((c) => c.request.method === "GET")).toBe(true);
  });

  it("the source's own price values the row, never as a selfPrice", async () => {
    const { value } = await run(pages, customBalance.fetchBalances(ctx()));
    const eth = value.balances.find((b) => b.symbol === "ETH");
    expect(eth).toMatchObject({ price: 3000.5, value: 4500.75 });
    expect(eth?.selfPrice).toBeUndefined();
  });

  it("fills every {address} in the path", async () => {
    const creds = {
      config: configOf({ pagination: undefined, path: "/v1/{address}/holdings/{address}" }),
      apiKey: KEY,
      address: ADDRESS,
    };
    const { calls } = await run(pages, customBalance.fetchBalances(ctx(creds)));
    expect(calls[0].request.url.pathname).toBe(`/v1/${ADDRESS}/holdings/${ADDRESS}`);
  });

  it("an {address} in the query with no address stored is refused before any request", async () => {
    const creds = {
      config: configOf({ path: "/v1/holdings", query: { owner: "{address}" } }),
      apiKey: KEY,
    };
    const { value, calls } = await failing(pages, customBalance.fetchBalances(ctx(creds)));
    expect(value._tag).toBe("UpstreamRefusedError");
    expect(calls).toHaveLength(0);
  });

  it("a key that can't travel in a header fails as auth, not as a crash", async () => {
    const creds = {
      config: configOf({ pagination: undefined }),
      apiKey: "abc\ndef",
      address: ADDRESS,
    };
    const { value, calls } = await failing(pages, customBalance.fetchBalances(ctx(creds)));
    expect(value._tag).toBe("UpstreamAuthError");
    expect(calls).toHaveLength(0);
  });

  it("the deployment origin is a public setting, not a secret", () => {
    const origin = customBalance.creds.find((f) => f.key === "BETTER_AUTH_URL");
    expect(origin?.type).toBe("public");
  });

  it("an address that is only dots is refused before any request", async () => {
    const creds = {
      config: configOf({ pagination: undefined }),
      apiKey: KEY,
      address: "..",
    };
    const { value, calls } = await failing(pages, customBalance.fetchBalances(ctx(creds)));
    expect(value._tag).toBe("UpstreamRefusedError");
    expect(calls).toHaveLength(0);
  });

  it("sends the fixed query, with the address filled in", async () => {
    const creds = {
      config: configOf({ pagination: undefined, query: { chain: "eth", owner: "{address}" } }),
      apiKey: KEY,
      address: ADDRESS,
    };
    const { calls } = await run(pages, customBalance.fetchBalances(ctx(creds)));
    const params = calls[0].request.url.searchParams;
    expect(params.get("chain")).toBe("eth");
    expect(params.get("owner")).toBe(ADDRESS);
  });

  describe("key placement", () => {
    const placed = async (auth: unknown) => {
      const creds = {
        config: configOf({ auth, pagination: undefined }),
        apiKey: KEY,
        address: ADDRESS,
      };
      const { calls } = await run(pages, customBalance.fetchBalances(ctx(creds)));
      return calls[0].request;
    };

    it("bearer → Authorization header", async () => {
      expect((await placed("bearer")).headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it("header → the named header, nowhere else", async () => {
      const request = await placed({ header: "X-Vault-Key" });
      expect(request.headers["x-vault-key"]).toBe(KEY);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.url.search).toBe("");
    });

    it("query → the named parameter", async () => {
      const request = await placed({ query: "apikey" });
      expect(request.url.searchParams.get("apikey")).toBe(KEY);
      expect(request.headers.authorization).toBeUndefined();
    });

    it.each([
      { query: "apikey" },
      { header: "X-Vault-Key" },
    ])("%j: the key reaches no span, log line or error", async (auth) => {
      const capture = recorder();
      const creds = { config: configOf({ auth }), apiKey: KEY, address: ADDRESS };
      const recorded = <A, E>(effect: Effect.Effect<A, E, UpstreamNeeds>) =>
        Effect.provide(effect, capture.layer);
      await run(pages, recorded(customBalance.fetchBalances(ctx(creds))));
      const { value: error } = await failing(
        () => json({}, { status: 500 }),
        recorded(customBalance.fetchBalances(ctx(creds))),
      );
      expect(capture.spanNames()).toContain("http.client.request");
      expectNoSecret([...capture.recorded(), safeJson(error)], [KEY]);
    });

    it("none → the key is never sent", async () => {
      const request = await placed("none");
      expect(JSON.stringify(request)).not.toContain(KEY);
    });
  });

  it("a keyed config without a key fails as auth before any request", async () => {
    const { value: error, calls } = await failing(
      pages,
      customBalance.fetchBalances(ctx({ config: configOf(), address: ADDRESS })),
    );
    expect(error._tag).toBe("UpstreamAuthError");
    expect(calls).toHaveLength(0);
  });

  describe("pagination", () => {
    it("page numbers in the path stop at the first empty page", async () => {
      const config = configOf({
        path: "/v1/holdings/{page}",
        pagination: { type: "page" },
        auth: "none",
      });
      const reply = ({ url }: HttpClientRequestLike) =>
        json(url.pathname.endsWith("/1") ? page1 : { data: { holdings: [] } });
      const { value, calls } = await run(reply, customBalance.fetchBalances(ctx({ config })));
      expect(calls.map((c) => c.request.url.pathname)).toEqual([
        "/v1/holdings/1",
        "/v1/holdings/2",
      ]);
      expect(value.balances).toHaveLength(3);
    });

    it("page numbers in a param start where the config says", async () => {
      const config = configOf({ pagination: { type: "page", param: "p", start: 0 } });
      const reply = (_: HttpClientRequestLike, nth: number) =>
        json(nth === 0 ? page1 : { data: { holdings: [] } });
      const { calls } = await run(
        reply,
        customBalance.fetchBalances(ctx({ ...ctx().account.creds, config })),
      );
      expect(calls.map((c) => c.request.url.searchParams.get("p"))).toEqual(["0", "1"]);
    });

    it(`stops at ${MAX_PAGES} pages and says so in a note`, async () => {
      // Each page holds a different coin, so only the cap ends the walk.
      const endless = (_: HttpClientRequestLike, nth: number) =>
        json({
          ...page2,
          data: {
            holdings: page2.data.holdings.map((h) => ({
              ...h,
              asset: { ...h.asset, ticker: `${h.asset.ticker}${nth}` },
            })),
          },
          next: `c${nth + 10}`,
        });
      const { value, calls } = await run(endless, customBalance.fetchBalances(ctx()));
      expect(calls).toHaveLength(MAX_PAGES);
      expect(value.balances).toHaveLength(MAX_PAGES);
      expect(value.note?.[0]?.content).toContain(`first ${MAX_PAGES} pages`);
    });

    it("a page that repeats the previous one ends the walk without counting it twice", async () => {
      const config = configOf({ pagination: { type: "page", param: "p" } });
      const { value, calls } = await run(
        () => json(page1),
        customBalance.fetchBalances(ctx({ ...ctx().account.creds, config })),
      );
      expect(calls).toHaveLength(2);
      const once = await run(
        () => json(page1),
        customBalance.fetchBalances(
          ctx({ ...ctx().account.creds, config: configOf({ pagination: undefined }) }),
        ),
      );
      expect(value.balances).toEqual(once.value.balances);
      // An ignored parameter and a wrong `start` look the same, so it says so.
      expect(value.note?.[0]?.content).toContain("already sent");
    });

    it("a 404 or a body without rows past the first page ends the walk", async () => {
      const config = configOf({ pagination: { type: "page", param: "p" } });
      for (const end of [
        () => json({ error: "not found" }, { status: 404 }),
        () => json({ error: "out of range" }),
      ]) {
        const reply = (_: HttpClientRequestLike, nth: number) => (nth === 0 ? json(page1) : end());
        const { value, calls } = await run(
          reply,
          customBalance.fetchBalances(ctx({ ...ctx().account.creds, config })),
        );
        expect(calls).toHaveLength(2);
        expect(value.balances.length).toBeGreaterThan(0);
      }
    });

    it("a later page without rows keeps what was read and says so; a 404 ends quietly", async () => {
      const config = configOf({ pagination: { type: "page", param: "p" } });
      const fetchWith = (end: () => Response) =>
        run(
          (_: HttpClientRequestLike, nth: number) => (nth === 0 ? json(page1) : end()),
          customBalance.fetchBalances(ctx({ ...ctx().account.creds, config })),
        );
      const broken = await fetchWith(() => json({ error: "try later" }));
      expect(broken.value.note?.[0]?.content).toContain("no rows");
      const ended = await fetchWith(() => json({ error: "not found" }, { status: 404 }));
      expect(ended.value.note).toBeUndefined();
    });

    it("a numeric cursor of 0 is the last page", async () => {
      const { calls } = await run(
        () => json({ ...page1, next: 0 }),
        customBalance.fetchBalances(ctx()),
      );
      expect(calls).toHaveLength(1);
    });

    it("pages that cycle are counted once and the read is marked uncertain", async () => {
      const config = configOf({ pagination: { type: "page", param: "p" } });
      // A, B, A, B, …: a source wrapping the page number.
      const reply = (_: HttpClientRequestLike, nth: number) => json(nth % 2 === 0 ? page1 : page2);
      const { value, calls } = await run(
        reply,
        customBalance.fetchBalances(ctx({ ...ctx().account.creds, config })),
      );
      expect(calls).toHaveLength(3);
      expect(value.balances.map((b) => b.symbol)).toEqual(["ETH", "USDC", "PTS", "SOL"]);
      expect(value.note?.[0]?.content).toContain("already sent");
    });

    it("cursors that cycle end the walk", async () => {
      const cycle = (_: HttpClientRequestLike, nth: number) =>
        json({
          ...page2,
          data: {
            holdings: page2.data.holdings.map((h) => ({
              ...h,
              asset: { ...h.asset, ticker: `${h.asset.ticker}${nth}` },
            })),
          },
          next: nth % 2 === 0 ? "a" : "b",
        });
      const { calls } = await run(cycle, customBalance.fetchBalances(ctx()));
      expect(calls).toHaveLength(3); // start, a, b — then a again
    });

    it("a cursor that repeats ends the walk", async () => {
      // Different rows each time, so only the cursor gives the loop away.
      const stuck = (_: HttpClientRequestLike, nth: number) =>
        json({
          ...page2,
          data: {
            holdings: page2.data.holdings.map((h) => ({
              ...h,
              asset: { ...h.asset, ticker: `${h.asset.ticker}${nth}` },
            })),
          },
          next: "same",
        });
      const { value, calls } = await run(stuck, customBalance.fetchBalances(ctx()));
      expect(calls).toHaveLength(2);
      expect(value.note?.[0]?.content).toContain("already sent");
    });
  });

  describe("safety at fetch time", () => {
    // Built past the save-time schema, as a config stored before a rule existed would be.
    const unchecked = (host: string) => ({
      config: { ...configOf(), host },
      apiKey: KEY,
      address: ADDRESS,
    });

    it.each([
      "127.0.0.1",
      "[::1]",
      "localhost",
      "svc.internal",
      "folio.example.com",
      "api.folio.example.com",
    ])("refuses %s without a request", async (host) => {
      const { value: error, calls } = await failing(
        pages,
        customBalance.fetchBalances(ctx(unchecked(host))),
      );
      expect(error._tag).toBe("UpstreamRefusedError");
      expect(calls).toHaveLength(0);
    });

    it("a redirect is refused, not followed", async () => {
      const redirect = () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
      const { value: error, calls } = await failing(redirect, customBalance.fetchBalances(ctx()));
      expect(error._tag).toBe("UpstreamRefusedError");
      expect(error.cause).toBe("redirect");
      expect(calls).toHaveLength(1);
    });

    it("a body over the cap is refused", async () => {
      const huge = () =>
        new Response(`{"data":{"holdings":[]},"pad":"${"x".repeat(MAX_BODY_BYTES)}"}`, {
          status: 200,
        });
      const { value: error } = await failing(huge, customBalance.fetchBalances(ctx()));
      expect(error._tag).toBe("UpstreamRefusedError");
      expect(error.cause).toContain("body over");
    });

    it("{address} without an address is refused without a request", async () => {
      const { value: error, calls } = await failing(
        pages,
        customBalance.fetchBalances(ctx({ config: configOf(), apiKey: KEY })),
      );
      expect(error._tag).toBe("UpstreamRefusedError");
      expect(calls).toHaveLength(0);
    });

    it("an address can't escape its path segment", async () => {
      const creds = { config: configOf(), apiKey: KEY, address: "../../admin?x=1" };
      const { calls } = await run(pages, customBalance.fetchBalances(ctx(creds)));
      expect(calls[0].request.url.pathname).toBe("/v1/wallets/..%2F..%2Fadmin%3Fx%3D1/holdings");
      expect(calls[0].request.url.host).toBe("api.vault.example");
    });
  });

  it("rows that match none of the configured fields fail as parse", async () => {
    const config = configOf({ fields: { symbol: "ticker", amount: "qty" } });
    const { value: error } = await failing(
      pages,
      customBalance.fetchBalances(ctx({ config, apiKey: KEY, address: ADDRESS })),
    );
    expect(error._tag).toBe("UpstreamParseError");
  });

  it("rows path that isn't an array fails as parse", async () => {
    const config = configOf({ rows: "data" });
    const { value: error } = await failing(
      pages,
      customBalance.fetchBalances(ctx({ config, apiKey: KEY, address: ADDRESS })),
    );
    expect(error._tag).toBe("UpstreamParseError");
  });

  it("an empty source is an empty account, not an error", async () => {
    const { value } = await run(
      () => json({ data: { holdings: [] } }),
      customBalance.fetchBalances(ctx()),
    );
    expect(value.balances).toEqual([]);
  });
});

describe("validateAccount", () => {
  it("checks the config without touching the network", async () => {
    const { value, calls } = await run(pages, customBalance.validateAccount(ctx()));
    expect(value).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses the deployment's own domain", async () => {
    const creds = { config: configOf({ host: "folio.example.com" }), address: ADDRESS };
    const { value: error, calls } = await failing(pages, customBalance.validateAccount(ctx(creds)));
    expect(error._tag).toBe("UpstreamRefusedError");
    expect(calls).toHaveLength(0);
  });
});
