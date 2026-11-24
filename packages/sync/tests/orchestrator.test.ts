import type { Balance } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "@folio/upstream-basic";
import { Duration, Effect, Fiber, type Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { depError, type FetchOutcome, Sweep, type SyncLogger, type SyncServices } from "../src";
import { type FakeOptions, fakeServices } from "./fakes";

const syncWith = (layer: Layer.Layer<SyncServices>, userId: string) =>
  Sweep.syncUser(userId).pipe(Effect.provide(layer));

const runSync = (layer: Layer.Layer<SyncServices>, userId: string) =>
  Effect.runPromise(syncWith(layer, userId));

// Orchestration only: retry / skip / revalue / failure isolation / logging / snapshot writes. Fetches use controllable stubs.

function capturingLogger() {
  const entries: Array<{ level: string; msg: string; props?: Record<string, unknown> }> = [];
  const mk = (level: string) => (msg: string, props?: Record<string, unknown>) =>
    entries.push({ level, msg, props });
  const log: SyncLogger = {
    debug: mk("debug"),
    info: mk("info"),
    warning: mk("warning"),
    error: mk("error"),
  };
  return { log, entries };
}

function account(overrides: Partial<AccountSafe> = {}): AccountSafe {
  return {
    id: "a1",
    userId: "u1",
    connectorId: "manual",
    platform: null,
    label: "Wallet",
    createdAt: 0,
    archivedAt: null,
    ...overrides,
  };
}
const bal = (symbol: string, value: number): Balance => ({
  symbol,
  tokenRef: `binance/issued:${symbol}`,
  amount: 1,
  value,
  kind: "spot",
});
const ok = (balances: Balance[]): FetchOutcome => ({
  status: "ok",
  balances,
  totalUsd: balances.reduce((s, b) => s + b.value, 0),
});

const makeServices = (accounts: AccountSafe[], over: Omit<FakeOptions, "accounts"> = {}) =>
  fakeServices({ accounts, ...over });

describe("syncUser: fetch balances then write snapshot", () => {
  it("ok outcome writes a snapshot with totalUsd = sum of rows", async () => {
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 32000)])),
    });
    const { results } = await runSync(layer, "u1");
    expect(results[0]).toMatchObject({
      accountId: "a1",
      ok: true,
      snapshotId: "snap-a1",
      totalUsd: 32000,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({ totalUsd: 32000 });
    expect(writes[0].input.balances).toHaveLength(1);
  });

  it("an empty balance list (real liquidation) still writes an empty snapshot with zero total", async () => {
    // Empty is a legitimate answer and must be distinguishable from failure (which writes nothing).
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([])),
    });
    const { results } = await runSync(layer, "u1");
    expect(results[0]).toMatchObject({ accountId: "a1", ok: true, totalUsd: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({ totalUsd: 0 });
    expect(writes[0].input.balances).toHaveLength(0);
  });

  it("passes balance-level notes through per row and account-level Note[] at the top", async () => {
    const note = { title: "Locked", icon: "warning" as const, content: "held" };
    const withNote: Balance = { ...bal("BTC", 1), note };
    const accountNote = [{ title: "Unconfirmed", icon: "warning" as const, content: "pending" }];
    const { layer, writes } = makeServices([account()], {
      fetch: () =>
        Effect.succeed({
          status: "ok" as const,
          balances: [withNote, bal("ETH", 2)],
          totalUsd: 3,
          note: accountNote,
        }),
    });
    await runSync(layer, "u1");
    expect(writes[0].input.balances[0]?.note).toEqual(note);
    expect(writes[0].input.balances[1]?.note).toBeUndefined();
    expect(writes[0].input.note).toEqual(accountNote);
  });

  it("revalue hook changes values and recomputes totalUsd before the snapshot write", async () => {
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 32000)])),
      revalue: (_connectorId, balances) =>
        Effect.succeed(balances.map((b) => ({ ...b, value: b.value * 2 }))),
    });
    const { results } = await runSync(layer, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 64000 });
    expect(writes[0].input.totalUsd).toBe(64000);
  });

  it("revalue throwing keeps the original values and the account stays ok", async () => {
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 32000)])),
      revalue: () => Effect.fail(depError("revalue", new Error("price down"))),
    });
    const { results } = await runSync(layer, "u1");
    expect(results[0]).toMatchObject({ ok: true, totalUsd: 32000 });
    expect(writes[0].input.totalUsd).toBe(32000);
  });
});

describe("syncUser: missing credentials skip / failure isolation", () => {
  it("needs-credentials gives ok:false skipped:true with the missing-credentials reason and no snapshot", async () => {
    const { layer, writes } = makeServices([account({ id: "n" })], {
      fetch: () => Effect.succeed({ status: "needs-credentials" } as const),
    });
    const { results } = await runSync(layer, "u1");
    expect(results[0]).toMatchObject({
      accountId: "n",
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
    expect(writes).toHaveLength(0);
  });

  it("a bad account does not block good ones; syncUser does not throw; only good accounts get snapshots", async () => {
    const good = account({ id: "good" });
    const bad = account({ id: "bad" });
    const { layer, writes } = makeServices([good, bad], {
      fetch: (acc) =>
        acc.id === "bad"
          ? Effect.fail(new UpstreamParseError({ upstream: "acme", where: "/boom" }))
          : Effect.succeed(ok([bal("BTC", 1)])),
    });
    const { results } = await runSync(layer, "u1");
    const byId = Object.fromEntries(results.map((r) => [r.accountId, r]));
    expect(byId.good.ok).toBe(true);
    expect(byId.bad).toMatchObject({ ok: false });
    expect(byId.bad.error).toContain("boom");
    expect(writes).toHaveLength(1);
    expect(writes[0].accountId).toBe("good");
  });
});

// The queue-consumer path (one message per account): must run the same `syncAccount` with the same creds as `syncUser`.
describe("syncOne: syncs only the listed account", () => {
  it("runs only the target, hands it its creds by id; other accounts are not fetched or written", async () => {
    const seen: Array<{ id: string; stored: Record<string, string> }> = [];
    const { layer, writes } = makeServices([account({ id: "x" }), account({ id: "y" })], {
      rawCreds: [
        { id: "x", creds: JSON.stringify({ k: "for-x" }) },
        { id: "y", creds: JSON.stringify({ k: "for-y" }) },
      ],
      fetch: (acc, stored) => {
        seen.push({ id: acc.id, stored });
        return Effect.succeed(ok([bal("BTC", 5)]));
      },
    });
    const result = await Effect.runPromise(Sweep.syncOne("u1", "y").pipe(Effect.provide(layer)));
    expect(Option.getOrThrow(result)).toMatchObject({ accountId: "y", ok: true, totalUsd: 5 });
    expect(seen).toEqual([{ id: "y", stored: { k: "for-y" } }]);
    expect(writes.map((w) => w.accountId)).toEqual(["y"]);
  });

  it("an unlisted account gives none and fetches nothing", async () => {
    let fetched = 0;
    const { layer, writes } = makeServices([account({ id: "x" })], {
      fetch: () => {
        fetched++;
        return Effect.succeed(ok([]));
      },
    });
    const result = await Effect.runPromise(Sweep.syncOne("u1", "gone").pipe(Effect.provide(layer)));
    expect(Option.isNone(result)).toBe(true);
    expect(fetched).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

describe("structured logs (level + safe fields)", () => {
  it("success logs info, missing creds warning, failure error; fields carry only safe keys", async () => {
    const { log, entries } = capturingLogger();
    const { layer } = makeServices(
      [account({ id: "g" }), account({ id: "n" }), account({ id: "f", connectorId: "okx" })],
      {
        log,
        fetch: (acc) => {
          if (acc.id === "n") return Effect.succeed({ status: "needs-credentials" } as const);
          if (acc.id === "f")
            return Effect.fail(new UpstreamAuthError({ upstream: "acme", where: "/t" }));
          return Effect.succeed(ok([bal("BTC", 1)]));
        },
      },
    );
    await runSync(layer, "u1");
    const byMsg = (m: string) => entries.find((e) => e.msg === m);
    expect(byMsg("account synced")?.level).toBe("info");
    expect(byMsg("account synced")?.props).toMatchObject({ accountId: "g", connectorId: "manual" });
    expect(byMsg("account sync skipped: needs credentials")?.level).toBe("warning");
    expect(byMsg("account sync failed")?.level).toBe("error");
    expect(byMsg("account sync failed")?.props).toMatchObject({
      accountId: "f",
      reason: "UpstreamAuthError",
    });
  });
});

// Backoff is tested on the Effect core: TestClock and controllable random need the Effect context.
//
// Pattern: fork, advance the fake clock, join; boundaries are asserted exactly.
describe("syncUser (Effect core): backoff retry (fetch only)", () => {
  // Fetch stub that fails the first failTimes calls, then succeeds.
  function flaky(makeErr: () => UpstreamError, failTimes: number) {
    let calls = 0;
    // Failures go through the error channel.
    const fetchBalances = (): Effect.Effect<FetchOutcome, UpstreamError> => {
      calls++;
      return calls <= failTimes ? Effect.fail(makeErr()) : Effect.succeed(ok([]));
    };
    return { fetchBalances, calls: () => calls };
  }

  // Runs an Effect on the fake clock: fork, advance generously, join. Cases needing exact timing fork themselves.
  const runWithClock = <A, E>(effect: Effect.Effect<A, E>, advanceMs = 100_000): Promise<A> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust(Duration.millis(advanceMs));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

  it("uses Retry-After instead of exponential backoff: no retry at 1233ms, retry after 1234ms", async () => {
    const { fetchBalances, calls } = flaky(
      () => new UpstreamRateLimitError({ upstream: "acme", where: "/t", retryAfterMs: 1234 }),
      1,
    );
    const { layer } = makeServices([account()], { fetch: fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(syncWith(layer, "u1"));
      // The first exponential step is 200ms; without Retry-After we'd have retried by now.
      yield* TestClock.adjust(Duration.millis(1233));
      expect(calls()).toBe(1);
      // Jitter adds at most baseMs (200ms).
      yield* TestClock.adjust(Duration.millis(400));
      const { results } = yield* Fiber.join(fiber);
      expect(calls()).toBe(2);
      expect(results[0].ok).toBe(true);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  });

  it("backoff doubles per step: the second wait is 400ms, not another 200ms", async () => {
    // Jitter is additive (+0..baseMs), so each step is an interval; assert interval bounds, not points.
    //   call 2 in [200, 400]; call 3 in [600, 1000]. Call 3 not before 600 proves the doubling.
    const { fetchBalances, calls } = flaky(
      () => new UpstreamUnavailableError({ upstream: "acme", where: "/t" }), // no Retry-After: exponential
      2,
    );
    const { layer } = makeServices([account()], { fetch: fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(syncWith(layer, "u1"));
      yield* TestClock.adjust(Duration.millis(199));
      expect(calls()).toBe(1); // first step is at least 200ms
      yield* TestClock.adjust(Duration.millis(201)); // t=400: call 2 has happened
      expect(calls()).toBe(2);
      yield* TestClock.adjust(Duration.millis(199)); // t=599: call 3 is earliest at 600
      expect(calls()).toBe(2);
      yield* TestClock.adjust(Duration.millis(401)); // t=1000: call 3 has happened
      yield* Fiber.join(fiber);
      expect(calls()).toBe(3);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  });

  it("Retry-After above the cap is clamped and still retried, not abandoned", async () => {
    const { fetchBalances, calls } = flaky(
      () => new UpstreamRateLimitError({ upstream: "acme", where: "/t", retryAfterMs: 60_000 }),
      1,
    );
    const { layer } = makeServices([account()], { fetch: fetchBalances });
    await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(syncWith(layer, "u1"));
      yield* TestClock.adjust(Duration.millis(4999));
      expect(calls()).toBe(1);
      yield* TestClock.adjust(Duration.millis(1201)); // 5s cap + 200ms jitter ceiling
      const { results } = yield* Fiber.join(fiber);
      expect(calls()).toBe(2);
      expect(results[0].ok).toBe(true);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  });

  it("exhausted retries give ok:false (isolated) and no snapshot", async () => {
    const { fetchBalances, calls } = flaky(
      () => new UpstreamUnavailableError({ upstream: "acme", where: "/t" }),
      99,
    );
    const { layer, writes } = makeServices([account()], { fetch: fetchBalances });
    const { results } = await runWithClock(syncWith(layer, "u1"));
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toContain("unavailable");
    expect(calls()).toBe(3); // RETRY_MAX_ATTEMPTS
    expect(writes).toHaveLength(0);
  });

  it("a non-retryable error (AUTH_FAILED) is not retried", async () => {
    const { fetchBalances, calls } = flaky(
      () => new UpstreamAuthError({ upstream: "acme", where: "/t" }),
      99,
    );
    const { layer } = makeServices([account()], { fetch: fetchBalances });
    const { results } = await runWithClock(syncWith(layer, "u1"));
    expect(results[0].ok).toBe(false);
    expect(calls()).toBe(1);
  });

  // attempt is counted by the schedule (recurs output + 1); account log fields are annotated once in syncAccount and survive the Schedule.
  it("retry log: attempt increments from 1 and carries the account context fields", async () => {
    const { log, entries } = capturingLogger();
    const { fetchBalances } = flaky(
      () => new UpstreamRateLimitError({ upstream: "acme", where: "/t", retryAfterMs: 300 }),
      2,
    );
    const { layer } = makeServices([account({ id: "a7", connectorId: "okx" })], {
      log,
      fetch: fetchBalances,
    });
    await runWithClock(syncWith(layer, "u1"));
    const retries = entries.filter((e) => e.msg === "provider call retrying");
    expect(retries.map((e) => e.props?.attempt)).toEqual([1, 2]);
    expect(retries[0]?.level).toBe("warning");
    expect(retries[0]?.props).toMatchObject({
      userId: "u1",
      accountId: "a7",
      connectorId: "okx",
      reason: "UpstreamRateLimitError",
      retryAfterMs: 300,
    });
  });

  it("exhausted retries log 2 entries (not 3); a non-retryable error logs 0", async () => {
    const exhausted = capturingLogger();
    const { layer: l1 } = makeServices([account()], {
      log: exhausted.log,
      fetch: flaky(() => new UpstreamUnavailableError({ upstream: "acme", where: "/t" }), 99)
        .fetchBalances,
    });
    await runWithClock(syncWith(l1, "u1"));
    expect(exhausted.entries.filter((e) => e.msg === "provider call retrying")).toHaveLength(2);

    const fatal = capturingLogger();
    const { layer: l2 } = makeServices([account()], {
      log: fatal.log,
      fetch: flaky(() => new UpstreamAuthError({ upstream: "acme", where: "/t" }), 99)
        .fetchBalances,
    });
    await runWithClock(syncWith(l2, "u1"));
    expect(fatal.entries.filter((e) => e.msg === "provider call retrying")).toHaveLength(0);
  });
});

describe("syncUser: bounded concurrency", () => {
  it("in-flight accounts never exceed the concurrency limit and all accounts run", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const accounts = Array.from({ length: 10 }, (_, i) => account({ id: `a${i}` }));
    const { layer, writes } = makeServices(accounts, {
      fetch: () =>
        Effect.promise(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5)); // force overlap
          inFlight--;
          return ok([]);
        }),
    });
    const { results } = await runSync(layer, "u1");
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(writes).toHaveLength(10);
    expect(maxInFlight).toBe(6); // SYNC_CONCURRENCY; 10 accounts > 6 saturates the pool
  });
});

describe("syncUser (Effect core): fetch timeout", () => {
  it("a hung provider times out, retries as retryable, then gives ok:false after exhaustion", async () => {
    let calls = 0;
    const { layer, writes } = makeServices([account()], {
      fetch: () => {
        calls++;
        return Effect.never; // never resolves; only the timeout ends it
      },
    });
    await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(syncWith(layer, "u1"));
      // 3 attempts x 20s timeout + two backoffs; advance generously.
      yield* TestClock.adjust(Duration.millis(100_000));
      const { results } = yield* Fiber.join(fiber);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain("unavailable at (timeout)");
      expect(calls).toBe(3); // RETRY_MAX_ATTEMPTS
      expect(writes).toHaveLength(0);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  });

  it("each attempt is timed separately: no timeout at 19.9s, timeout and retry after 20s", async () => {
    let calls = 0;
    const { layer } = makeServices([account()], {
      fetch: () => {
        calls++;
        return Effect.never;
      },
    });
    await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(syncWith(layer, "u1"));
      yield* TestClock.adjust(Duration.millis(19_900));
      expect(calls).toBe(1); // FETCH_TIMEOUT_MS not reached
      // 20s timeout + 200 first backoff + 200 jitter ceiling = 20_400; advance to 20_500.
      yield* TestClock.adjust(Duration.millis(600));
      expect(calls).toBe(2);
      yield* Effect.forkChild(Fiber.interrupt(fiber)); // wrap up without waiting for the other two attempts
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  });
});

// These pin the ordering contract: mint runs first, once, and its answer feeds both revalue and the snapshot write.
describe("syncAccount: mint and revalue ordering", () => {
  it("mint runs before revalue, and revalue receives mint's answer", async () => {
    const order: string[] = [];
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 100)])),
      mint: (balances) =>
        Effect.sync(() => {
          order.push("mint");
          return new Map(balances.map((b) => [b.tokenRef as string, `tk_${b.symbol}`]));
        }),
      revalue: (_connectorId, balances, idByRef) =>
        Effect.sync(() => {
          order.push("revalue");
          expect(idByRef.get("binance/issued:BTC")).toBe("tk_BTC");
          return balances;
        }),
    });

    await runSync(layer, "u1");
    expect(order).toEqual(["mint", "revalue"]);
    expect(writes[0].input.balances[0].tokenId).toBe("tk_BTC");
  });

  it("a round mints only once (the snapshot write does not recognise again)", async () => {
    let calls = 0;
    const { layer } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 100), bal("ETH", 50)])),
      mint: (balances) =>
        Effect.sync(() => {
          calls++;
          return new Map(balances.map((b) => [b.tokenRef as string, `tk_${b.symbol}`]));
        }),
    });

    await runSync(layer, "u1");
    expect(calls).toBe(1); // two holdings, one batched lookup
  });

  it("mint throwing still writes the snapshot (token_id empty), price falls back to the provider's, one warning logged", async () => {
    const { log, entries } = capturingLogger();
    const { layer, writes } = makeServices([account()], {
      log,
      fetch: () => Effect.succeed(ok([bal("BTC", 100)])),
      mint: () => Effect.fail(depError("mint", new Error("d1 down"))),
      revalue: (_connectorId, balances, idByRef) =>
        Effect.sync(() => {
          expect(idByRef.size).toBe(0); // empty map, not undefined
          return balances;
        }),
    });

    await runSync(layer, "u1");
    expect(writes).toHaveLength(1);
    expect(writes[0].input.balances[0].tokenId).toBeUndefined();
    expect(writes[0].input.totalUsd).toBe(100);
    expect(entries.some((e) => e.level === "warning" && e.msg.includes("mint failed"))).toBe(true);
  });

  it("a ref that can't be recognised stays out of the map: its token_id is empty, other rows unaffected", async () => {
    const { layer, writes } = makeServices([account()], {
      fetch: () => Effect.succeed(ok([bal("BTC", 100), bal("SCAM", 5)])),
      mint: () => Effect.succeed(new Map([["binance/issued:BTC", "tk_BTC"]])),
    });

    await runSync(layer, "u1");
    // Rows are told apart by usdValue (BTC=100 / SCAM=5).
    const rows = writes[0].input.balances;
    expect(rows.find((r) => r.usdValue === 100)?.tokenId).toBe("tk_BTC");
    expect(rows.find((r) => r.usdValue === 5)?.tokenId).toBeUndefined();
  });
});
