import type { ScriptType } from "@folio/bitcoin-derive";
import type { UpstreamNeeds } from "@folio/upstream-basic";
import { isRetryable, type UpstreamError } from "@folio/upstream-basic";
import { type HttpStub, httpStub, runClient } from "@folio/upstreams/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { blockbookProvider } from "../../../src/connectors/bitcoin/provider";
import xpubBasicFixture from "./fixtures/xpub-basic.json";

// Rejected creds / unparseable xpub → `false`; unreachable upstream → error channel for retry.
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ctx = (input: { addressOrXpub: string; scriptType?: ScriptType }) =>
  ({
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: {},
  }) as never;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, UpstreamError, UpstreamNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, UpstreamError, UpstreamNeeds>,
): Promise<UpstreamError> => runClient(stub, Effect.flip(effect));

describe("validateAccount", () => {
  it("address: hits /address/, 200 → true", async () => {
    const stub = httpStub(() => json({ address: ADDR, balance: "0", unconfirmedBalance: "0" }));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })))).toBe(
      true,
    );
    expect(stub.calls[0].request.url.pathname).toContain("/address/");
  });

  // A real recorded basic response: it has no `unconfirmedBalance` (only tokens+ details do).
  it("xpub: hits /xpub/ asking only for basic details", async () => {
    const stub = httpStub(() => json(xpubBasicFixture.response));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ZPUB84 })))).toBe(
      true,
    );
    expect(stub.calls[0].request.url.pathname).toContain("/xpub/");
    expect(stub.calls[0].request.url.searchParams.get("details")).toBe("basic");
  });

  it("rejected credentials (403) → false, not the error channel", async () => {
    const stub = httpStub(() => json({}, 403));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })))).toBe(
      false,
    );
  });

  it("all nodes failing (5xx) → error channel (retryable), not false", async () => {
    const stub = httpStub(() => json({}, 500));
    const err = await failing(
      stub,
      blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })),
    );
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("permanent server rejection (400) → not retryable", async () => {
    // An invalid xpub gets the same 400 from every node; a 4xx won't change on retry.
    const stub = httpStub(() => json({}, 400));
    const err = await failing(
      stub,
      blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })),
    );
    expect(isRetryable(err)).toBe(false);
  });

  it("invalid extended key (junk) → false, fails before any request", async () => {
    const stub = httpStub(() => json({}));
    expect(
      await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: "zpubGARBAGE" }))),
    ).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});
