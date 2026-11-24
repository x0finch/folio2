import { UpstreamAuthError, UpstreamRateLimitError } from "@folio/client-core";
import { InvalidInput, NotFound } from "@folio/db";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { toError } from "@/lib/server/errors";

describe("toError", () => {
  it("upstream failure: one sentence with upstream name / category / path, original error as cause", () => {
    const mapped = toError(
      new UpstreamAuthError({ upstream: "binance", where: "/api/v3/account", status: 401 }),
    );
    expect(mapped.message).toBe("binance UpstreamAuthError on /api/v3/account (401)");
    expect(mapped.cause).toBeInstanceOf(UpstreamAuthError);
  });

  it("no status code: none is invented", () => {
    const mapped = toError(new UpstreamRateLimitError({ upstream: "coingecko", where: "/simple" }));
    expect(mapped.message).toBe("coingecko UpstreamRateLimitError on /simple");
  });

  it("message carries no query and no cause summary", () => {
    const mapped = toError(
      new UpstreamAuthError({
        upstream: "okx",
        where: "/api/v5/account/balance",
        cause: "signature mismatch for key ABC123",
      }),
    );
    expect(mapped.message).not.toContain("ABC123");
    expect(mapped.message).toBe("okx UpstreamAuthError on /api/v5/account/balance");
  });

  it("NotFound / InvalidInput pass through as is: same object, not rewrapped", () => {
    const notFound = new NotFound({ entity: "account", id: "a1" });
    expect(toError(notFound)).toBe(notFound);
    expect(toError(notFound).message).toBe("account not found: a1");

    const invalid = new InvalidInput({ what: "tag", why: "already pinned" });
    expect(toError(invalid)).toBe(invalid);
    expect(toError(invalid).message).toBe("tag: already pinned");
  });

  it("plain Error passes through as is", () => {
    const err = new Error("plain");
    expect(toError(err)).toBe(err);
  });
});

describe("the handler name survives in the Cause", () => {
  const failing = Effect.fn("someHandler")(function* () {
    return yield* Effect.fail(new NotFound({ entity: "account", id: "a1" }));
  });

  it("after toError the handler is still identifiable", async () => {
    const exit = await Effect.runPromiseExit(failing().pipe(Effect.mapError(toError)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("someHandler");
  });
});
