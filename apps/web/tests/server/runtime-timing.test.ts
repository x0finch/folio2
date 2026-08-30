import { InvalidInput } from "@folio/db";
import { configure, type LogRecord } from "@logtape/logtape";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runEffect } from "@/lib/server/runtime";

// server fn 在 Workers 日志里路径是 REDACTED —— 靠 runEffect 这一行 info 排快慢。
// 只钉 handler + durationMs(+ forUser 挂上的 userId),不碰入参(P6.7)。

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
  it("成功也打 handler + durationMs", async () => {
    await captureLogs();
    const handleNoop = Effect.fn("noopTiming")(function* () {
      return yield* Effect.succeed(null);
    });
    await runEffect(handleNoop)({ data: undefined, context: { userId: "user-timing" } });

    expectSafeTiming(timingOf(), "noopTiming");
  });

  it("失败也打 handler + durationMs", async () => {
    await captureLogs();
    const handleFail = Effect.fn("failTiming")(function* () {
      return yield* Effect.fail(new InvalidInput({ what: "test", why: "nope" }));
    });
    await expect(
      runEffect(handleFail)({ data: undefined, context: { userId: "user-timing" } }),
    ).rejects.toThrow();

    expectSafeTiming(timingOf(), "failTiming");
  });
});
