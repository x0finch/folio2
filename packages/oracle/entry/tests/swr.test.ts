import { UpstreamRateLimitError } from "@folio/client-core";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { swr } from "../src/tokens/swr";

// SWR orchestration is the only place that knows "read local, judge stale, fetch, write back"; its semantics are tested once here.
describe("swr", () => {
  const hit = (value: string, stale: boolean) => Effect.succeed(Option.some({ value, stale }));
  const miss = Effect.succeed(Option.none<{ value: string; stale: boolean }>());
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);

  it("fresh: returns directly, no upstream, no write-back", async () => {
    const fetch = vi.fn(() => Effect.succeed(Option.some("new")));
    const write = vi.fn(() => Effect.void);
    const got = await run(hit("fresh", false).pipe(swr("t", Effect.suspend(fetch), write)));
    expect(got).toEqual(Option.some("fresh"));
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("stale: fetches, writes back, returns the new value", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(
      hit("old", true).pipe(swr("t", Effect.succeed(Option.some("new")), write)),
    );
    expect(got).toEqual(Option.some("new"));
    expect(write).toHaveBeenCalledWith("new");
  });

  it("miss: fetches, writes back", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(miss.pipe(swr("t", Effect.succeed(Option.some("new")), write)));
    expect(got).toEqual(Option.some("new"));
    expect(write).toHaveBeenCalledOnce();
  });

  it("upstream has none: serves the old value as is, no write-back (expired is not deleted)", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(hit("old", true).pipe(swr("t", Effect.succeed(Option.none()), write)));
    expect(got).toEqual(Option.some("old"));
    expect(write).not.toHaveBeenCalled();
  });

  it('upstream failure counts as "none": degrades to local, does not throw', async () => {
    const boom = Effect.fail(
      new UpstreamRateLimitError({ upstream: "src", where: "/x", status: 429 }),
    );
    expect(await run(hit("old", true).pipe(swr("t", boom, () => Effect.void)))).toEqual(
      Option.some("old"),
    );
    // Not even an old value: none, the caller degrades
    expect(await run(miss.pipe(swr("t", boom, () => Effect.void)))).toEqual(Option.none());
  });

  // Only `UpstreamError` (the four typed kinds) is caught; a defect (our own bug) must not be swallowed as an upstream failure.
  it('our own bug is not swallowed: a defect bubbles up, not treated as "upstream has none"', async () => {
    const bug = Effect.sync<Option.Option<string>>(() => {
      throw new TypeError("undefined is not a function");
    });
    await expect(run(hit("old", true).pipe(swr("t", bug, () => Effect.void)))).rejects.toThrow(
      /not a function/,
    );
  });
});
