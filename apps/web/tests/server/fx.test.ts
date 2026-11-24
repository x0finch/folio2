import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import { displayRate as rateOf } from "@/lib/server/preferences/fx";
import { runEffect } from "@/lib/server/runtime";

// App-level wiring of display-currency rates against real D1 (Miniflare): the risk is the per-user cache
// really being written and read back, which an in-memory fake can't show. Runs via `runEffect`, the server fn entry.
// The upstream is always stubbed, recording calls so assertions can count outbound requests.

const displayRate = (userId: string, code: string) =>
  runEffect(() => rateOf(code))({ data: undefined, context: { userId } });

// The only writer of rates is the queue's `fx` job; run the production consumer and expect an ack
// (also when the upstream is down: the reference layer degrades itself instead of redelivering).
const warmFx = async (userId: string): Promise<void> => {
  let acked = false;
  const message: JobMessage = {
    id: "m-fx",
    body: { kind: "fx", userId },
    attempts: 1,
    ack: () => {
      acked = true;
    },
    retry: () => {},
  };
  await Effect.runPromise(consumeMessage(message));
  expect(acked).toBe(true);
};

const USER = "user-fx";
const OTHER = "user-fx-other";

async function insertUser(id: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, id, `${id}@example.com`, 0, now, now)
    .run();
}

async function resetUser(): Promise<void> {
  for (const id of [USER, OTHER]) {
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run(); // cascade → user_cache
  }
  await insertUser(USER);
}

// The upstream endpoint is BTC-based: value = how much of the currency 1 BTC is worth.
// usdPerUnit(EUR) = 100000 / 92000 ~ 1.087; KRW is deliberately absent (the "not covered upstream" case).
const RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" },
    eur: { value: 92000, type: "fiat" },
    jpy: { value: 15000000, type: "fiat" },
  },
};

let outbound: string[] = [];

beforeEach(async () => {
  await resetUser();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    return new Response(JSON.stringify(RATES), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("USD", () => {
  it("constant 1, and no outbound call at all", async () => {
    expect(await displayRate(USER, "USD")).toBe(1);
    expect(outbound).toEqual([]);
  });
});

describe("after warming (rates are refreshed only by the queue's fx job)", () => {
  it("after the fx job warms -> rate readable, the read makes zero outbound calls", async () => {
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]);
  });

  it("that run pulls everything at once -> other currencies are warm too (one response writes all)", async () => {
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(USER, "JPY")).toBeCloseTo(100000 / 15000000, 9);
    expect(outbound).toEqual([]);
  });

  it("really persisted in this user's cache (not only in memory)", async () => {
    await warmFx(USER);
    const row = await env.DB.prepare("SELECT v FROM user_cache WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .first<{ v: string }>();
    expect(Number(row?.v)).toBeCloseTo(100000 / 92000, 6);
  });

  // Both users exist and each has a cache; the one never warmed can't read the other's.
  it("per-user isolation: another user never warmed -> gets nothing, no outbound call", async () => {
    await insertUser(OTHER);
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(OTHER, "EUR")).toBeUndefined();
    expect(outbound).toEqual([]);
  });
});

describe("when no rate is available", () => {
  it("cold cache -> undefined, no outbound call (read endpoints never go back to the source)", async () => {
    expect(await displayRate(USER, "EUR")).toBeUndefined();
    expect(outbound).toEqual([]);
  });

  it("upstream doesn't cover the currency -> still undefined after warming (caller falls back to USD), nothing dirty written", async () => {
    await warmFx(USER);
    expect(await displayRate(USER, "KRW")).toBeUndefined();
  });

  it("upstream down -> fx job still acks (reference layer degrades), read is undefined, does not throw", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await warmFx(USER);
    expect(await displayRate(USER, "EUR")).toBeUndefined();
  });

  it("upstream returns a bad response (usd base missing) -> same undefined, no throw", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ rates: { eur: { value: 1 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await warmFx(USER);
    expect(await displayRate(USER, "EUR")).toBeUndefined();
  });
});

describe("soft expiry", () => {
  it("expired cache still returns the stale value without going outbound -- an old rate beats none", async () => {
    await warmFx(USER);
    // Push the expiry stamp into the past.
    await env.DB.prepare("UPDATE user_cache SET expires_at = 1 WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .run();
    outbound = [];

    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]); // reads never go outbound for freshness; warming does
  });
});

// `getCurrencyPreference`: the code arrives as a parameter from the browser; this is "validate code -> ask rate -> shape" on real D1.
describe("getCurrencyPreference", () => {
  const preferenceOf = (userId: string, code: string) =>
    runEffect(handleGetCurrencyPreference)({ data: { code }, context: { userId } });

  it("supported currency + rate available -> that currency and its rate", async () => {
    await warmFx(USER);
    const pref = await preferenceOf(USER, "EUR");
    expect(pref.currency.code).toBe("EUR");
    expect(pref.rate).toBeCloseTo(100000 / 92000, 6);
  });

  it('rate unavailable -> falls back to USD overall (not "EUR at 1")', async () => {
    await warmFx(USER);
    const pref = await preferenceOf(USER, "KRW");
    expect(pref).toMatchObject({ currency: { code: "USD" }, rate: 1 });
  });

  it("unrecognized code -> treated as USD, and no outbound call (the code is user-editable input)", async () => {
    const pref = await preferenceOf(USER, "DOGE");
    expect(pref).toMatchObject({ currency: { code: "USD" }, rate: 1 });
    expect(outbound).toEqual([]);
  });
});
