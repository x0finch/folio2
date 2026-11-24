import { FolioHttpClient, makeRequester } from "@folio/upstreams";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

// Pins that outbound HTTP still works in real workerd after the switch to `@effect/platform`'s HttpClient.
// `FetchHttpClient` calls `globalThis.fetch(url, ...)` as a bare function (no bind); workerd accepts that
// (only method-style calls throw `Illegal invocation`), so this runs the real `FolioHttpClient` and
// stubs only `globalThis.fetch`.
describe("outbound in workerd", () => {
  it("`FolioHttpClient` sends requests -- an unbound fetch call does not throw Illegal invocation", async () => {
    const seen: { url?: string; hadThis?: boolean } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown, input) {
      seen.url = String(input);
      seen.hadThis = this !== undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof globalThis.fetch);

    const request = makeRequester({ baseUrl: "https://up.example.com", upstream: "probe" });

    const out = await Effect.runPromise(
      request("/v1/thing", Schema.Struct({ ok: Schema.Number })).pipe(
        Effect.provide(FolioHttpClient),
      ),
    );

    expect(out).toEqual({ ok: 1 });
    expect(seen.url).toBe("https://up.example.com/v1/thing");
    vi.restoreAllMocks();
  });

  it('upstream 5xx maps to "upstream unreachable" here too, not a defect', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const request = makeRequester({ baseUrl: "https://up.example.com", upstream: "probe" });

    const err = await Effect.runPromise(
      Effect.flip(request("/v1/thing", Schema.Unknown).pipe(Effect.provide(FolioHttpClient))),
    );

    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.where).toBe("/v1/thing"); // pathname only
    vi.restoreAllMocks();
  });
});
