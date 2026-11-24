import { env } from "cloudflare:test";
import type { Balance } from "@folio/connectors-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { REFERENCE_JOB_UPSTREAM_CALLS } from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import type { Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutDaily } from "@/lib/server/jobs/schedule";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import { runEffect } from "@/lib/server/runtime";
import { revalue } from "@/lib/server/sync/revalue";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// The reference layer's five small jobs: rates / platforms / catalogue / DeFi graph / note pruning, one message each.
// Each pins three things: outbound count within the derived budget (counted on real fetches), a rerun makes zero outbound calls
// (redelivery on an at-least-once queue must be free), and the data is really written. Also pins that the read paths
// (display currency / fiat dropdown / sync revaluation) never hit the upstream, even on a cold cache.

describe("jobs/reference", () => {
  const USER = "h-jobs-reference";

  const consume = async (body: Job) => {
    const state = { acked: false, retried: false };
    const message: JobMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts: 1,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    await Effect.runPromise(consumeMessage(message));
    return state;
  };

  const ACKED = { acked: true, retried: false };

  // The upstream endpoint is BTC-based: value = how much of the currency 1 BTC is worth. All supported currencies are given
  // (as the real upstream does): `fx.warm()` skips only when all supported currencies are fresh, so a gap would refetch every
  // time (still within budget at 1 call, but no longer "rerun makes zero outbound").
  const RATES = {
    rates: {
      ...Object.fromEntries(
        SUPPORTED_CURRENCIES.map((c) => [c.code.toLowerCase(), { value: 50_000, type: "fiat" }]),
      ),
      btc: { value: 1, type: "crypto" },
      usd: { value: 100000, type: "fiat" },
      eur: { value: 92000, type: "fiat" },
    },
  };
  const EUR_USD = 100000 / 92000;

  const warmFx = async () => {
    stubOutbound([["/exchange_rates", () => json(RATES)]]);
    expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
  };

  // Push the rates' expiry stamp into the past ("not warmed for a long time").
  const expireFx = () =>
    env.DB.prepare("UPDATE user_cache SET expires_at = 1 WHERE user_id = ? AND k LIKE 'fx:%'")
      .bind(USER)
      .run();

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  describe("fx", () => {
    it("one call pulls all currencies into this user's cache; run again right after warming -> zero outbound", async () => {
      const first = stubOutbound([["/exchange_rates", () => json(RATES)]]);
      expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
      expect(first.calls).toHaveLength(1);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.fx);
      const hit = await db(USER).cache.get("fx:EUR");
      expect(Option.map(hit, (e) => Number(e.value))).toEqual(Option.some(EUR_USD));

      const again = blockOutbound();
      expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });
  });

  describe("platforms", () => {
    const CHAINS = [{ id: "arbitrum-one", name: "Arbitrum One", chain_identifier: 42161 }];

    it("a chain key missing from the latest snapshot -> fetch the whole chain table once, write only those keys; rerun -> zero outbound", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      await seedSnapshot(USER, acc.id, Date.now(), [
        { tokenId: "tok-a", amount: 1, usdValue: 1, platform: "arbitrum-one" },
      ]);

      const first = stubOutbound([["/asset_platforms", () => json(CHAINS)]]);
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.platforms);
      const hit = await db(USER).cache.get("platform:arbitrum-one");
      expect(Option.isSome(hit)).toBe(true);

      const again = blockOutbound();
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });

    it("no snapshot -> asks nothing", async () => {
      const outbound = blockOutbound();
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(outbound.calls).toEqual([]);
    });
  });

  describe("catalogue", () => {
    const MARKETS = [
      { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 50_000, market_cap_rank: 1 },
      { id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3_000, market_cap_rank: 2 },
    ];

    it("cold -> fetch the catalogue once into the cache (within budget); rerun inside the one-week TTL -> zero outbound", async () => {
      const first = stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      expect(await consume({ kind: "catalogue", userId: USER })).toEqual(ACKED);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.catalogue);
      expect(Option.isSome(await db(USER).cache.get("warm"))).toBe(true);

      const again = blockOutbound();
      expect(await consume({ kind: "catalogue", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });
  });

  describe("defi-logos", () => {
    it("collects the protocol graph from the latest snapshot's meta into the cache, zero outbound; rerun overwrites with the same value", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      await seedSnapshot(USER, acc.id, Date.now(), [
        {
          tokenId: "tok-a",
          amount: 1,
          usdValue: 1,
          kind: "defi",
          meta: { protocol: "aave", protocolLogo: "https://example.test/aave.png" },
        },
      ]);
      const outbound = blockOutbound();

      expect(await consume({ kind: "defi-logos", userId: USER })).toEqual(ACKED);
      expect(await consume({ kind: "defi-logos", userId: USER })).toEqual(ACKED);

      expect(outbound.calls).toHaveLength(REFERENCE_JOB_UPSTREAM_CALLS["defi-logos"]);
      const hit = await db(USER).cache.get("defi-logo:aave");
      expect(Option.map(hit, (e) => e.value)).toEqual(Option.some("https://example.test/aave.png"));
    });
  });

  describe("prune-notes", () => {
    const noteOf = async (snapshotId: string) =>
      (
        await env.DB.prepare("SELECT note FROM snapshots WHERE id = ?")
          .bind(snapshotId)
          .first<{ note: string | null }>()
      )?.note ?? null;

    const withNote = (accountId: string, takenAt: number) =>
      db(USER).snapshots.write(accountId, {
        takenAt,
        totalUsd: 1,
        note: [{ title: `n@${takenAt}`, content: [{ label: "n", value: 1 }] }],
        balances: [],
      });

    it("prunes notes older than 7 days, keeps those within 7 days, zero outbound; redelivery prunes 0 rows", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      const now = Date.now();
      const old = await withNote(acc.id, now - 8 * DAY);
      const recent = await withNote(acc.id, now - 6 * DAY);
      const latest = await withNote(acc.id, now);
      const outbound = blockOutbound();

      expect(await consume({ kind: "prune-notes", userId: USER })).toEqual(ACKED);
      expect(await noteOf(old)).toBeNull();
      expect(await noteOf(recent)).not.toBeNull();
      expect(await noteOf(latest)).not.toBeNull();

      // Idempotent: a rerun changes nothing.
      expect(await consume({ kind: "prune-notes", userId: USER })).toEqual(ACKED);
      expect(await noteOf(recent)).not.toBeNull();
      expect(outbound.calls).toHaveLength(REFERENCE_JOB_UPSTREAM_CALLS["prune-notes"]);
    });
  });

  describe("the daily cron's enqueue", () => {
    it("one prune-notes + one catalogue per user, not delayed; no upstream calls", async () => {
      const outbound = blockOutbound();
      const sent: Enqueued[] = [];
      const result = await Effect.runPromise(
        fanOutDaily(["u1", "u2"]).pipe(
          Effect.provideService(JobQueue, {
            poke: Effect.void,
            send: (batch) => Effect.sync(() => void sent.push(...batch)),
          }),
        ),
      );
      expect(sent).toEqual([
        { job: { kind: "prune-notes", userId: "u1" } },
        { job: { kind: "catalogue", userId: "u1" } },
        { job: { kind: "prune-notes", userId: "u2" } },
        { job: { kind: "catalogue", userId: "u2" } },
      ]);
      expect(result).toEqual({ jobs: 4 });
      expect(outbound.calls).toEqual([]);
    });
  });

  // Read paths only read the cache: a read endpoint must not hit the upstream and write the db.
  describe("read paths make no outbound calls", () => {
    const preferenceOf = (code: string) =>
      runEffect(handleGetCurrencyPreference)({ data: { code }, context: { userId: USER } });

    it("getCurrencyPreference: cold cache -> falls back to USD, zero outbound", async () => {
      const outbound = blockOutbound();
      expect(await preferenceOf("EUR")).toMatchObject({ currency: { code: "USD" }, rate: 1 });
      expect(outbound.calls).toEqual([]);
    });

    it("getCurrencyPreference: expired rates still use the old value, zero outbound", async () => {
      await warmFx();
      await expireFx();
      const outbound = blockOutbound();
      const pref = await preferenceOf("EUR");
      expect(pref.currency.code).toBe("EUR");
      expect(pref.rate).toBeCloseTo(EUR_USD, 6);
      expect(outbound.calls).toEqual([]);
    });

    it("listFiatOptions: cold cache -> options still returned, EUR without a price, zero outbound", async () => {
      const outbound = blockOutbound();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(out.length).toBeGreaterThan(1);
      expect((out.find((o) => o.symbol === "EUR") as { price?: number }).price).toBeUndefined();
      expect((out.find((o) => o.symbol === "USD") as { price?: number }).price).toBe(1);
      expect(outbound.calls).toEqual([]);
    });

    it("listFiatOptions: after warming has prices, zero outbound", async () => {
      await warmFx();
      const outbound = blockOutbound();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      const eur = out.find((o) => o.symbol === "EUR") as { price?: number; asOf?: number };
      expect(eur.price).toBeCloseTo(EUR_USD, 6);
      expect(eur.asOf).toBeTruthy(); // the fetch time comes with the price
      expect(outbound.calls).toEqual([]);
    });

    const eurCash: Balance = {
      kind: "spot",
      symbol: "EUR",
      amount: 100,
      value: 100,
      tokenRef: "fiat/issued:EUR",
    };

    it("revalue: expired fiat rates also read only the cache, zero outbound", async () => {
      await warmFx();
      await expireFx();
      const outbound = blockOutbound();
      const [out] = await call(USER, revalue(false, [eurCash], new Map()));
      expect(out?.value).toBeCloseTo(100 * EUR_USD, 6);
      expect(outbound.calls).toEqual([]);
    });

    it("revalue: cold cache -> keeps the provider's original value, zero outbound", async () => {
      const outbound = blockOutbound();
      const [out] = await call(USER, revalue(false, [eurCash], new Map()));
      expect(out?.value).toBe(100);
      expect(outbound.calls).toEqual([]);
    });
  });
});
