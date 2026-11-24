import { Duration, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { defineUpstream } from "../../src/runtime/define";
import { httpStub, jsonResponse as json, runClient } from "../../src/runtime/testing";

const ANY = Schema.Unknown;

const acme = defineUpstream({
  id: "acme",
  label: "Acme",
  base: "https://api.acme.test",
  baseOverride: "ACME_BASE",
  keys: ["ACME_KEY"],
  userAgent: "folio-test",
  headers: (keys) => ({ "x-key": keys.ACME_KEY }),
  limits: {
    default: { limit: 2, window: Duration.seconds(1), scope: "key" },
    slow: { limit: 1, window: Duration.seconds(10), scope: "egress" },
  },
});

const env = { ACME_KEY: "k1" };

describe("defineUpstream", () => {
  it("a missing key fails as auth before any request", async () => {
    const stub = httpStub(() => json({}));
    const err = await runClient(stub, Effect.flip(acme.connect({})));
    expect(err._tag).toBe("UpstreamAuthError");
    expect(err.message).toBe("acme auth at (config)");
    expect(stub.calls).toHaveLength(0);
  });

  it("sends user agent and key headers to the base, or to the override", async () => {
    const stub = httpStub(() => json({}));
    await runClient(
      stub,
      Effect.gen(function* () {
        yield* (yield* acme.connect(env)).request("/v1/x", ANY);
        yield* (yield* acme.connect({ ...env, ACME_BASE: "http://127.0.0.1:9/fake" })).request(
          "/v1/x",
          ANY,
        );
      }),
    );
    const [plain, overridden] = stub.calls.map((c) => c.request);
    expect(plain.url.href).toBe("https://api.acme.test/v1/x");
    expect(plain.headers["user-agent"]).toBe("folio-test");
    expect(plain.headers["x-key"]).toBe("k1");
    expect(overridden.url.href).toBe("http://127.0.0.1:9/fake/v1/x");
  });

  it("the default limit gates `request`; a named one gates only `via`", async () => {
    const stub = httpStub(() => json({}));
    const sent = await runClient(
      stub,
      Effect.gen(function* () {
        const call = yield* acme.connect(env);
        const fiber = yield* Effect.forkChild(
          Effect.all([1, 2, 3].map(() => call.request("/v1/x", ANY))),
        );
        yield* TestClock.adjust(Duration.millis(1));
        const beforeSpacing = stub.calls.length;
        yield* TestClock.adjust(Duration.millis(500));
        yield* Fiber.join(fiber);
        yield* call.via("slow")("/v1/y", ANY);
        return beforeSpacing;
      }),
    );
    expect(sent).toBe(2); // the burst; the third waits one spacing
    expect(stub.calls).toHaveLength(4);
  });
});
