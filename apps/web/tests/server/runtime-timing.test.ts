import { InvalidInput } from "@folio/db";
import { configure, type LogRecord } from "@logtape/logtape";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runEffect } from "@/lib/server/runtime";
import { serverFn } from "@/lib/server/server-fn";

// server fn paths are REDACTED in Workers logs, so the runEffect info line is the only timing signal.
// Pins handler + durationMs (+ userId from forUser) and nothing from the input.

const captured: LogRecord[] = [];

const timingOf = () =>
  captured.find(
    (record) =>
      record.level === "info" &&
      record.category.join(".") === "folio.server-fn" &&
      record.message.join("") === "server fn",
  );

const captureLogs = async () => {
  captured.length = 0;
  await configure({
    reset: true,
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{ category: ["folio"], sinks: ["capture"], lowestLevel: "debug" }],
  });
};

const expectSafeTiming = (timing: LogRecord | undefined, handler: string) => {
  expect(timing?.properties).toMatchObject({
    handler,
    userId: "user-timing",
    durationMs: expect.any(Number),
  });
  expect(timing?.properties?.durationMs).toBeGreaterThanOrEqual(0);
  expect(timing?.properties).not.toHaveProperty("data");
  expect(timing?.properties).not.toHaveProperty("creds");
};

describe("server fn timing", () => {
  it("also logs handler + durationMs on success", async () => {
    await captureLogs();
    const handleNoop = serverFn("noopTiming")(function* () {
      return yield* Effect.succeed(null);
    });
    await runEffect(handleNoop)({ data: undefined, context: { userId: "user-timing" } });

    expectSafeTiming(timingOf(), "noopTiming");
  });

  it("also logs handler + durationMs on failure", async () => {
    await captureLogs();
    const handleFail = serverFn("failTiming")(function* () {
      return yield* Effect.fail(new InvalidInput({ what: "test", why: "nope" }));
    });
    await expect(
      runEffect(handleFail)({ data: undefined, context: { userId: "user-timing" } }),
    ).rejects.toThrow();

    expectSafeTiming(timingOf(), "failTiming");
  });

  it("durationMs reflects real handler time (not the ~0 of building the description)", async () => {
    await captureLogs();
    const handleSlow = serverFn("slowTiming")(function* () {
      yield* Effect.sleep("50 millis");
      return null;
    });
    await runEffect(handleSlow)({ data: undefined, context: { userId: "user-timing" } });

    const timing = timingOf();
    expectSafeTiming(timing, "slowTiming");
    // Timing must span execution, not effect construction; 20ms threshold absorbs scheduler jitter.
    expect(timing?.properties?.durationMs as number).toBeGreaterThanOrEqual(20);
  });
});
