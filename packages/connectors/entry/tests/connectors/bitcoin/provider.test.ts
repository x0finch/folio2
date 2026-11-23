import type { ScriptType } from "@folio/bitcoin-derive";
import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import {
  type ConnectorError,
  type ProviderNeeds,
  validateCredentials,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bitcoinAccountCreds, blockbookProvider } from "../../../src/connectors/bitcoin/provider";
import addressFixture from "./fixtures/address.json";
import xpubFixture from "./fixtures/xpub.json";

let stub: HttpStub;
const run = <A>(effect: Effect.Effect<A, ConnectorError, ProviderNeeds>): Promise<A> =>
  runClient(stub, effect);
const failing = (
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

// Derivation correctness is covered by @folio/bitcoin-derive's offline vectors.
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
// In the recording the highest used external index is 41 (0/28–0/30 unused); change only used 1/0.
const LAST_USED41 = "bc1q8jkgp7wyyc47h5fj83y3pc5r2n24u6thcdxe04";
const NEXT42 = "bc1qg6sjfylq0sdj258ghvch4quz9379ajqvqnjtux";
const NEXT43 = "bc1qa3w5eljjp5ehlmqqj2975nvmnz29q2qprlegd0";
const CHANGE0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const mempool = (a: string) => `https://mempool.space/address/${a}`;

// CredsOf makes every field a required key, so scriptType is passed explicitly (may be undefined).
type Ctx = Parameters<typeof blockbookProvider.fetchBalances>[0];
function ctx(
  input: { addressOrXpub: string; scriptType?: ScriptType } = { addressOrXpub: ADDR },
  providerCreds: Record<string, string> = {},
): Ctx {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: providerCreds,
  } as unknown as Ctx;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Routes by pathname only: the client rotates over four nodes from a module-level start, so the
// host drifts across tests. Each test builds its own stub.
function mockBlockbook(opts: { xpub?: unknown; address?: unknown; status?: number }) {
  stub = httpStub((request) => {
    if (opts.status && opts.status >= 400) return json({}, opts.status);
    return request.url.pathname.includes("/xpub/") ? json(opts.xpub) : json(opts.address);
  });
  return stub;
}

describe("blockbookProvider.fetchBalances — address mode (golden fixture)", () => {
  it("recorded response → expected spot row (confirmed → amount, value 0, details in note)", async () => {
    mockBlockbook({ address: addressFixture.response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: addressFixture.request.addressOrXpub })),
    );
    expect(balances).toEqual(addressFixture.expected);
    // 500000 pending sats → a single Unconfirmed section.
    expect(note).toEqual([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.005, unit: "BTC" }],
      },
    ]);
  });

  it("zero balance and nothing pending → empty (no balance, so no note)", async () => {
    mockBlockbook({ address: { address: ADDR, balance: "0", unconfirmedBalance: "0" } });
    const { balances, note } = await run(blockbookProvider.fetchBalances(ctx()));
    expect(balances).toEqual([]);
    expect(note).toEqual([]);
  });
});

describe("blockbookProvider.fetchBalances — xpub mode (golden fixture, server-side derivation)", () => {
  // xpub.json is a real Blockbook recording (BIP84 public test-vector zpub, details=tokenBalances&
  // tokens=used): 40 used addresses, all with zero balance.
  it("recorded xpub response (zero balance) → no spot row; lastUsed = highest used external index + locally derived next", async () => {
    mockBlockbook({ xpub: xpubFixture.response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: xpubFixture.request.addressOrXpub })),
    );
    expect(balances).toEqual(xpubFixture.expected);
    // Nothing pending → no Unconfirmed; all balances zero → no distribution sections.
    expect(note).toEqual([
      {
        title: "Receive addresses",
        icon: "info",
        content: [
          { label: "Last used #41", value: LAST_USED41, href: mempool(LAST_USED41) },
          { label: "Next #42", value: NEXT42, href: mempool(NEXT42) },
          { label: "Next #43", value: NEXT43, href: mempool(NEXT43) },
        ],
      },
    ]);
  });

  it("non-zero balance + pending → spot row, Unconfirmed, receive/change distribution (non-zero only)", async () => {
    // The recorded wallet is empty, so copy a real response and change only the numbers:
    // 80000 sats confirmed + 10000 pending; receive 0/0 holds 50000, change 1/0 holds 30000.
    const response = structuredClone(xpubFixture.response);
    response.balance = "80000";
    response.unconfirmedBalance = "10000";
    for (const t of response.tokens) {
      if (t.name === RECV0) t.balance = "50000";
      if (t.name === CHANGE0) t.balance = "30000";
    }
    mockBlockbook({ xpub: response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84 })),
    );
    expect(balances).toEqual([
      { symbol: "BTC", amount: 0.0008, value: 0, kind: "spot", tokenRef: "bitcoin/native" },
    ]);
    expect(note).toEqual([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.0001, unit: "BTC" }],
      },
      {
        title: "Receive addresses",
        icon: "info",
        content: [
          { label: "Last used #41", value: LAST_USED41, href: mempool(LAST_USED41) },
          { label: "Next #42", value: NEXT42, href: mempool(NEXT42) },
          { label: "Next #43", value: NEXT43, href: mempool(NEXT43) },
        ],
      },
      {
        title: "Receive distribution",
        icon: "info",
        content: [{ label: RECV0, value: 0.0005, unit: "BTC", href: mempool(RECV0) }],
      },
      {
        title: "Change distribution",
        icon: "info",
        content: [{ label: CHANGE0, value: 0.0003, unit: "BTC", href: mempool(CHANGE0) }],
      },
    ]);
  });

  it("a used zero-balance address (e.g. mempool-only receipt) counts as lastUsed but not in distribution", async () => {
    mockBlockbook({
      xpub: {
        address: ZPUB84,
        balance: "50000",
        unconfirmedBalance: "0",
        tokens: [
          { name: RECV0, path: "m/84'/0'/0'/0/0", transfers: 2, balance: "50000" },
          { name: RECV1, path: "m/84'/0'/0'/0/1", transfers: 1, balance: "0" },
        ],
      },
    });
    const { note } = await run(blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84 })));
    const sections = note ?? [];
    const rowsOf = (c: (typeof sections)[number]["content"]) => (Array.isArray(c) ? c : []);
    const labels = sections.flatMap((s) => rowsOf(s.content).map((r) => r.label));
    expect(labels).toContain("Last used #1"); // lastUsed.index=1
    expect(labels).toContain("Next #2");
    const dist = sections.find((s) => s.title === "Receive distribution");
    expect(rowsOf(dist?.content ?? []).map((r) => r.label)).toEqual([RECV0]);
  });

  it("queries /xpub/ with the zpub itself (the prefix wins over scriptType)", async () => {
    const _spy = mockBlockbook({ xpub: xpubFixture.response });
    await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84, scriptType: "legacy" })),
    );
    const url = String(stub.calls[0].request.url.href);
    expect(url).toContain("/xpub/");
    expect(url).toContain(ZPUB84); // not rewritten by scriptType=legacy
  });
});

describe("blockbookProvider.fetchBalances — error mapping", () => {
  it("429 → rate limit; 500 (every node) → upstream unavailable", async () => {
    mockBlockbook({ status: 429 });
    expect(await failing(blockbookProvider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorRateLimitError",
    });
    mockBlockbook({ status: 500 });
    expect(await failing(blockbookProvider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorUnavailableError",
    });
  });

  it("node override: only that node is hit, no built-in public node", async () => {
    const overrides = { BLOCKBOOK_API_BASE: "http://127.0.0.1:3399/blockbook" };
    // Exactly the declared key, public (not encrypted / exported).
    expect(blockbookProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(blockbookProvider.creds.every((f) => f.type === "public")).toBe(true);

    mockBlockbook({ status: 500 });
    await failing(blockbookProvider.fetchBalances(ctx({ addressOrXpub: ADDR }, overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    // A 500 would normally rotate nodes; with one configured there's exactly one call.
    expect(urls).toEqual([`http://127.0.0.1:3399/blockbook/address/${ADDR}`]);
  });
});

describe("addressOrXpub validation (account.creds validator)", () => {
  const accept = (id: string, extra: Record<string, string> = {}) =>
    validateCredentials(bitcoinAccountCreds, { addressOrXpub: id, ...extra });
  const reject = (id: string) => expect(accept(id)).rejects.toThrow(/addressOrXpub/);

  it("accepts addresses + xpub/ypub/zpub; scriptType optional", async () => {
    await expect(accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).resolves.toBeDefined();
    await expect(accept("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).resolves.toBeDefined();
    await expect(accept(ZPUB84)).resolves.toBeDefined();
    await expect(accept(ADDR, { scriptType: "taproot" })).resolves.toBeDefined();
  });

  it("rejects EVM 0x / junk", async () => {
    await reject("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await reject("not-an-address");
  });
});
