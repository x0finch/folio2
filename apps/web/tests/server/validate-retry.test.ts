import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";

// Liveness probe for adding accounts. Runs in the workers pool because connector-registry reads `cloudflare:workers` env.
// Stubs the global fetch to exercise the real path (form -> ConnectorRegistry.validate -> provider -> outbound) with the evm connector.
// `validateAccount` separates rejected credentials (401/403 -> returns `false`) from an unreachable upstream (429 / 5xx / network ->
// error channel): transport failures retry, rejected credentials never do.

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Assembles the registry and runs the probe.
const validateAccountCreds = (...args: Parameters<ConnectorRegistry["validate"]>): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(ConnectorRegistry, (r) => r.validate(...args)).pipe(
      Effect.provide(ConnectorRegistry.Default),
    ),
  );

afterEach(() => vi.restoreAllMocks());

// Answers in order: nth outbound call returns statuses[n-1] (last one repeats); a fresh Response each time (a body reads once).
function scriptedFetch(statuses: number[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return new Response(status === 200 ? "{}" : "", { status });
  });
}

describe("liveness probe", () => {
  it("upstream healthy -> passes", async () => {
    const spy = scriptedFetch([200]);
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("bad credentials (shape gate) -> no outbound call, waiting won't help", async () => {
    const spy = scriptedFetch([200]);
    await expect(
      validateAccountCreds("evm", { address: "not-an-address" }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("no probe requested -> no outbound call at all", async () => {
    const spy = scriptedFetch([200]);
    await expect(validateAccountCreds("evm", { address: ADDRESS })).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("transport failures retry, rejected credentials do not", () => {
  it("transient 429 -> retries once and succeeds (rabby reports RATE_LIMITED, retry sends again)", async () => {
    const spy = scriptedFetch([429, 200]); // second call succeeds
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2); // 429 throws -> retry -> 200 passes
  });

  it("persistent 429 -> fails after retries are exhausted (error surfaces, not squashed to false)", async () => {
    const spy = scriptedFetch([429]); // every call 429
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(); // rate-limit error surfaces (not "could not verify")
    expect(spy).toHaveBeenCalledTimes(2); // VALIDATE_RETRY_ATTEMPTS = 1 + 1 retry
  });

  it("network failure -> fails after retries are exhausted", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("credentials rejected (403 -> AUTH_FAILED) -> fails at once, no retry (waiting won't help)", async () => {
    const spy = scriptedFetch([403]);
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(/could not verify/); // provider returned false -> explicit credentials error
    expect(spy).toHaveBeenCalledTimes(1); // false does not trigger a retry (only thrown retryable errors do)
  });

  // Retry-After beyond our max wait -> give up at once instead of clamping: the user is watching the form,
  // so surface the error immediately (the opposite of the background sync policy, which clamps and waits).
  it("Retry-After above the max wait -> gives up at once (no clamp-and-retry)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
      );
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // no second call
  });
});
