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

  it("base and nodes: base first, then mirrors; the override replaces them all", async () => {
    const mirrored = defineUpstream({
      id: "mirrored",
      label: "Mirrored",
      base: "https://a.test",
      mirrors: ["https://b.test"],
      baseOverride: "MIRRORED_BASE",
    });
    const stub = httpStub(() => json({}));
    await runClient(
      stub,
      Effect.gen(function* () {
        const call = yield* mirrored.connect({});
        for (const node of call.nodes) yield* node("/x", ANY);
        expect(call.base).toBe("https://a.test");
        const pinned = yield* mirrored.connect({ MIRRORED_BASE: "http://127.0.0.1:9" });
        expect(pinned.base).toBe("http://127.0.0.1:9");
        expect(pinned.nodes).toHaveLength(1);
        yield* pinned.nodes[0]("/x", ANY);
      }),
    );
    expect(stub.calls.map((c) => c.request.url.href)).toEqual([
      "https://a.test/x",
      "https://b.test/x",
      "http://127.0.0.1:9/x",
    ]);
  });

  it("named hosts: each to its own base, or to its own override, and declared as env", async () => {
    const split = defineUpstream({
      id: "split",
      label: "Split",
      base: "https://api.split.test",
      hosts: {
        futures: { base: "https://fapi.split.test", baseOverride: "SPLIT_FAPI_BASE" },
        plain: { base: "https://plain.split.test" },
      },
    });
    expect(split.envNames).toEqual(["SPLIT_FAPI_BASE"]);
    const stub = httpStub(() => json({}));
    await runClient(
      stub,
      Effect.gen(function* () {
        const call = yield* split.connect({});
        yield* call.host("futures")("/x", ANY);
        yield* call.host("plain")("/x", ANY);
        const proxied = yield* split.connect({ SPLIT_FAPI_BASE: "http://127.0.0.1:9/f" });
        yield* proxied.host("futures")("/x", ANY);
        yield* proxied.request("/x", ANY);
      }),
    );
    expect(stub.calls.map((c) => c.request.url.href)).toEqual([
      "https://fapi.split.test/x",
      "https://plain.split.test/x",
      "http://127.0.0.1:9/f/x",
      "https://api.split.test/x",
    ]);
  });

  it("limit tiers: the first whose `when` holds gates `request`", async () => {
    const tiered = defineUpstream({
      id: "tiered",
      label: "Tiered",
      base: "https://api.tiered.test",
      optionalKeys: ["TIERED_KEY", "TIERED_PRO_KEY"],
      limits: {
        default: [
          { limit: 1, window: Duration.seconds(1), scope: "key", when: "TIERED_PRO_KEY" },
          { limit: 1, window: Duration.seconds(5), scope: "key", when: "keyed" },
          { limit: 1, window: Duration.seconds(30), scope: "egress", when: "keyless" },
        ],
      },
    });
    // Whether the second of two requests has gone out after `ms`.
    const secondSentAfter = (env: Record<string, string>, ms: number) => {
      const stub = httpStub(() => json({}));
      return runClient(
        stub,
        Effect.gen(function* () {
          const call = yield* tiered.connect(env);
          yield* Effect.forkChild(Effect.all([1, 2].map(() => call.request("/x", ANY))));
          yield* TestClock.adjust(Duration.millis(ms));
          return stub.calls.length === 2;
        }),
      );
    };
    expect(await secondSentAfter({ TIERED_PRO_KEY: "p", TIERED_KEY: "d" }, 1_000)).toBe(true);
    expect(await secondSentAfter({ TIERED_KEY: "d" }, 1_000)).toBe(false);
    expect(await secondSentAfter({ TIERED_KEY: "d" }, 5_000)).toBe(true);
    expect(await secondSentAfter({}, 5_000)).toBe(false);
    expect(await secondSentAfter({}, 30_000)).toBe(true);
  });

  it("hosts sharing the base override declare it once", () => {
    const shared = defineUpstream({
      id: "shared",
      label: "Shared",
      base: "https://a.shared.test",
      baseOverride: "SHARED_BASE",
      hosts: { b: { base: "https://b.shared.test", baseOverride: "SHARED_BASE" } },
    });
    expect(shared.envNames).toEqual(["SHARED_BASE"]);
  });
});
