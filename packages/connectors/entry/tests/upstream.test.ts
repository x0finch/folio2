import type { ConnectorError } from "@folio/connectors-basic";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { bestEffortVerdict } from "../src/upstream";

// Verdict for multi-bucket best-effort fetches, shared by binance / okx / bybit: each splits an account into isolated buckets fetched
// concurrently, and on failure must answer one question: hand this round to retry, or degrade to a partial snapshot.
const err = (tag: string) => ({ _tag: tag }) as unknown as ConnectorError;
const AUTH = "ConnectorAuthError"; // permission not granted: waiting does not help
const SHAPE = "ConnectorFailure"; // upstream changed shape: waiting does not help
const LIMIT = "ConnectorRateLimitError"; // rate limited: waiting helps
const DOWN = "ConnectorUnavailableError"; // upstream down: waiting helps

const ok = (name: string) => ({ name, result: Result.succeed(name) });
const ko = (name: string, tag: string) => ({ name, result: Result.fail(err(tag)) });

describe("bestEffortVerdict", () => {
  it("all fine: best effort, the failure list is empty", () => {
    const v = bestEffortVerdict([ok("Trading"), ok("Funding")]);
    expect(Result.isSuccess(v)).toBe(true);
    if (Result.isSuccess(v)) expect(v.success).toEqual([]);
  });

  it('partly failed and all are "waiting does not help": degrade, the failure list goes to the caller to build a note', () => {
    const v = bestEffortVerdict([ok("Trading"), ko("Savings", AUTH), ko("Staking", SHAPE)]);
    expect(Result.isSuccess(v)).toBe(true);
    if (Result.isSuccess(v)) expect(v.success.map((f) => f.name)).toEqual(["Savings", "Staking"]);
  });

  it('partly failed with a "waiting helps" one: whole failure, handed to retry', () => {
    // A degraded partial snapshot would overwrite real assets while the next round could fetch them.
    const transient = err(DOWN);
    const v = bestEffortVerdict([
      { name: "Trading", result: Result.succeed("Trading") },
      { name: "Funding", result: Result.fail(transient) },
    ]);
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(transient);
  });

  it("transient mixed with permission errors: fails with the transient one (the reason to retry)", () => {
    const transient = err(LIMIT);
    const v = bestEffortVerdict([
      ko("Savings", AUTH),
      { name: "Trading", result: Result.fail(transient) },
      ok("Funding"),
    ]);
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(transient);
  });

  it("several transient errors: fails with the rate-limit one first (it may carry Retry-After for retry)", () => {
    const limit = err(LIMIT);
    const v = bestEffortVerdict([
      ko("Trading", DOWN),
      { name: "Funding", result: Result.fail(limit) },
    ]);
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(limit);
  });

  it('total failure (even if all are "waiting does not help"): whole failure, no empty snapshot', () => {
    // The whole key was revoked: degrading would write an empty snapshot wiping all the account's assets.
    const first = err(AUTH);
    const v = bestEffortVerdict([
      { name: "Trading", result: Result.fail(first) },
      ko("Funding", AUTH),
    ]);
    expect(Result.isFailure(v)).toBe(true);
    if (Result.isFailure(v)) expect(v.failure).toBe(first);
  });

  it("no buckets at all: best effort (an empty account is not a failure)", () => {
    const v = bestEffortVerdict([]);
    expect(Result.isSuccess(v)).toBe(true);
  });
});
