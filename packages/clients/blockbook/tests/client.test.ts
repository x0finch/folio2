import type { UpstreamError } from "@folio/upstream-basic";
import type { Outbound } from "@folio/upstreams";
import { type HttpStub, httpStub, jsonResponse as json, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  BlockbookClient,
  type BlockbookClientApi,
  type BlockbookConfig,
  make,
} from "../src/client";
import { BLOCKBOOK_BASES, USER_AGENT } from "../src/constants";

const XPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const ADDR = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

// Fake egress that records every request. Replaces the `HttpClient` service, not `globalThis.fetch`: the client sits on the official one, so
// only replacing at that layer exercises the real path (headers, method, body).
function stub(reply: (url: URL, nth: number) => Response | Promise<Response>) {
  const s = httpStub((request, nth) => reply(request.url, nth));
  return { fn: s, calls: s.calls };
}

const XPUB_BODY = {
  address: XPUB,
  balance: "12345",
  unconfirmedBalance: "0",
  unconfirmedTxs: 0,
  txs: 3,
};
const ADDR_BODY = { address: ADDR, balance: "500", unconfirmedBalance: "0" };

// Construction is pure (no gate, so no Scope).
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: BlockbookClientApi) => Effect.Effect<A, E, Outbound>,
  config: BlockbookConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: BlockbookClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
  config: BlockbookConfig = {},
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)), config);

// The rotation start is module-level (so not every sync starts from btc2), making "which base was hit" drift across cases;
// each case gets its own bases and asserts only the number of requests and the order among them.
const basesOf = (n: number) => Array.from({ length: n }, (_, i) => `https://node${i}.test/api/v2`);

describe("request shape", () => {
  it("xpub: server-side derivation, details / tokens go in the query not the path", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });

    expect(calls[0].request.url.pathname).toBe(`/api/v2/xpub/${XPUB}`);
    expect(calls[0].request.url.searchParams.get("details")).toBe("tokenBalances");
    expect(calls[0].request.url.searchParams.get("tokens")).toBe("used");
  });

  // Real shape of the basic tier (fields as recorded, see connectors-entry fixtures/xpub-basic.json): no `unconfirmedBalance`.
  it("xpubSummary: details=basic, and accepts the real shape without unconfirmedBalance", async () => {
    const basic = {
      address: XPUB,
      balance: "0",
      totalReceived: "5631015",
      totalSent: "5631015",
      unconfirmedTxs: 0,
      txs: 276,
      addrTxCount: 276,
      usedTokens: 40,
    };
    const { fn, calls } = stub(() => json(basic));
    const res = await withClient(fn, (c) => c.xpubSummary(XPUB), { bases: basesOf(1) });
    expect(res.balance).toBe("0");
    expect(calls[0].request.url.pathname).toBe(`/api/v2/xpub/${XPUB}`);
    expect(calls[0].request.url.searchParams.get("details")).toBe("basic");
    expect(calls[0].request.url.searchParams.get("tokens")).toBeNull();
  });

  it("the xpub query can be overridden", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB, { details: "tokens", tokens: "derived" }), {
      bases: basesOf(1),
    });
    expect(calls[0].request.url.searchParams.get("details")).toBe("tokens");
    expect(calls[0].request.url.searchParams.get("tokens")).toBe("derived");
  });

  it("descriptor parentheses are encoded", async () => {
    // A descriptor like `tr(xpub…)` straight into the path makes some nodes misparse.
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(`tr(${XPUB})`), { bases: basesOf(1) });
    expect(calls[0].request.url.href).toContain("%28");
    expect(calls[0].request.url.href).toContain("%29");
  });

  it("address: a single address", async () => {
    const { fn, calls } = stub(() => json(ADDR_BODY));
    await withClient(fn, (c) => c.address(ADDR), { bases: basesOf(1) });
    expect(calls[0].request.url.pathname).toBe(`/api/v2/address/${ADDR}`);
  });

  it("must send a User-Agent (Workers' fetch sends none and the WAF answers 403)", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect(calls[0].request.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("the UA is deliberately neutral: no project name, no repo address", () => {
    // The request itself is sensitive (it carries an xpub); a UA naming the project would tie who is watching an address to a person.
    expect(USER_AGENT).toBe("Mozilla/5.0");
    expect(USER_AGENT.toLowerCase()).not.toContain("folio");
  });

  it("returns the upstream shape as is, no translation", async () => {
    // satoshi stays a string; conversion to number belongs to the adapter.
    const { fn } = stub(() => json(XPUB_BODY));
    const res = await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect(res).toEqual(XPUB_BODY);
    expect(typeof res.balance).toBe("string");
  });

  it("without bases uses the four built-in public nodes", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB));
    expect(BLOCKBOOK_BASES).toContain(`${calls[0].request.url.origin}/api/v2`);
  });
});

describe('multi-endpoint: switching node is this upstream\'s "retry"', () => {
  it("a node rate-limits: switches to the next", async () => {
    const { fn, calls } = stub((_u, nth) =>
      nth === 0 ? json({}, { status: 429 }) : json(XPUB_BODY),
    );
    const res = await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
    expect(res).toEqual(XPUB_BODY);
    expect(calls).toHaveLength(2);
    // It switches to the next node, not retrying the same one.
    expect(calls[0].request.url.origin).not.toBe(calls[1].request.url.origin);
  });

  it("5xx and network failure switch too", async () => {
    for (const first of [() => json({}, { status: 503 }), () => Promise.reject(new Error("dns"))]) {
      const { fn, calls } = stub((_u, nth) => (nth === 0 ? first() : json(XPUB_BODY)));
      await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
      expect(calls).toHaveLength(2);
    }
  });

  it("4xx does not switch: an invalid xpub would get the same 400 from four nodes", async () => {
    const { fn, calls } = stub(() => json({ error: "invalid xpub" }, { status: 400 }));
    const err = await failing(fn, (c) => c.xpub("garbage"), { bases: basesOf(4) });
    expect(err._tag).toBe("UpstreamRefusedError");
    expect(calls).toHaveLength(1); // the three wasted round trips did not happen
  });

  it("credentials rejected / unreadable response do not switch either", async () => {
    const { fn: auth, calls: authCalls } = stub(() => json({}, { status: 403 }));
    expect((await failing(auth, (c) => c.xpub(XPUB), { bases: basesOf(4) }))._tag).toBe(
      "UpstreamAuthError",
    );
    expect(authCalls).toHaveLength(1);

    const { fn: junk, calls: junkCalls } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(junk, (c) => c.xpub(XPUB), { bases: basesOf(4) }))._tag).toBe(
      "UpstreamParseError",
    );
    expect(junkCalls).toHaveLength(1);
  });

  it("all down: reports the last node's error, and each node is tried only once", async () => {
    const { fn, calls } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(calls).toHaveLength(4);
  });

  it("the rotation start moves: not every round begins at the same node", async () => {
    const bases = basesOf(4);
    const seen: string[] = [];
    const { fn } = stub((url) => {
      seen.push(url.origin);
      return json(XPUB_BODY);
    });
    for (let i = 0; i < 4; i++) {
      await withClient(fn, (c) => c.xpub(XPUB), { bases });
    }
    // Four calls should hit more than one node (the start advances one slot each time).
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it("empty bases falls back to the built-in list, not unable to send", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: [] });
    expect(calls).toHaveLength(1);
  });
});

describe("error classification", () => {
  it("errors carry `upstream`, answering who failed", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) })).upstream).toBe(
      "blockbook",
    );
  });

  it("429 carries Retry-After", async () => {
    const { fn } = stub(() => json({}, { status: 429, headers: { "retry-after": "6" } }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(6000);
  });

  it("the failure info carries no query; the xpub in the pathname is unavoidable", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    // The query is not in: details/tokens are not in `where`.
    expect(err.where).not.toContain("details");
    // But Blockbook's URL shape is /xpub/{token}, so the xpub is always in the pathname.
    // It is `public` here (stored in plain text), so acceptable; this pins that we know it is there.
    expect(err.where).toContain("/xpub/");
  });
});

// Goes through the Tag / Layer path: production uses only it, and tests otherwise all call `make` directly, so whether what `layer()` assembles
// equals `make` was never verified.
describe("wiring: the Tag path", () => {
  it("what `BlockbookClient.layer(...)` assembles is the `make` client", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    const out = await runClient(
      fn,
      Effect.flatMap(BlockbookClient, (client) => client.xpub(XPUB)).pipe(
        Effect.provide(BlockbookClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
