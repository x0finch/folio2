import { configure, type LogRecord } from "@logtape/logtape";
import { Context, Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { logCategory, logTapeLogger, withLogTapeLogger } from "@/lib/server/effect-log";

// Forwards Effect logs to LogTape. It runs on error paths, so if it throws, a degradation becomes a 500.

const captured: LogRecord[] = [];

beforeAll(async () => {
  await configure({
    reset: true,
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{ category: ["folio"], sinks: ["capture"], lowestLevel: "debug" }],
  });
});

// Both installs — the layer and the context-patching withLogTapeLogger — must pass the same assertions.
const routes = {
  layer: <A>(effect: Effect.Effect<A>) => Effect.runPromise(Effect.provide(effect, logTapeLogger)),
  context: <A>(effect: Effect.Effect<A>) =>
    Effect.runPromiseWith(withLogTapeLogger(Context.empty()))(effect),
};

describe.each(Object.entries(routes))("Effect log → LogTape (%s)", (_route, run) => {
  it("warning + annotations → LogTape warning + properties", async () => {
    captured.length = 0;
    await run(
      Effect.logWarning("oracle: upstream fetch failed, serving local data").pipe(
        Effect.annotateLogs({ at: "tokens.priceOf", error: "UpstreamRateLimitError", status: 429 }),
      ),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe("warning");
    expect(captured[0]?.category).toEqual(["folio", "oracle"]);
    expect(captured[0]?.properties).toMatchObject({
      at: "tokens.priceOf",
      error: "UpstreamRateLimitError",
      status: 429,
    });
    expect(captured[0]?.message.join("")).toContain("upstream fetch failed");
  });

  it("each of the four levels maps to its own; debug is not raised to info", async () => {
    captured.length = 0;
    await run(
      Effect.all([
        Effect.logError("boom"),
        Effect.logWarning("careful"),
        Effect.logInfo("fyi"),
        // The threshold here is All; level filtering is left to LogTape's config.
        Effect.logDebug("noise"),
      ]),
    );
    expect(captured.map((r) => r.level)).toEqual(["error", "warning", "info", "debug"]);
  });

  // One forwarder routes by category; a second logger per area would write every line twice.
  it("logCategory picks the category; untagged lines go to oracle", async () => {
    captured.length = 0;
    await run(
      Effect.all([Effect.logInfo("synced").pipe(logCategory("sync")), Effect.logInfo("priced")]),
    );
    expect(captured.map((r) => r.category)).toEqual([
      ["folio", "sync"],
      ["folio", "oracle"],
    ]);
  });

  it("each line written once, and category stays out of properties", async () => {
    captured.length = 0;
    await run(Effect.logInfo("once").pipe(logCategory("sync")));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties).toEqual({});
  });

  it("no annotations doesn't throw (properties is an empty object)", async () => {
    captured.length = 0;
    await run(Effect.logWarning("bare"));
    expect(captured[0]?.properties).toEqual({});
  });
});
