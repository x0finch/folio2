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

  it("durationMs 反映 handler 真实耗时(而非描述构建期的 ~0)", async () => {
    await captureLogs();
    const handleSlow = Effect.fn("slowTiming")(function* () {
      yield* Effect.sleep("50 millis");
      return null;
    });
    await runEffect(handleSlow)({ data: undefined, context: { userId: "user-timing" } });

    const timing = timingOf();
    expectSafeTiming(timing, "slowTiming");
    // 修 bug 前计时测的是「描述构建」,两次 performance.now() 只差几微秒 → durationMs 恒 ~0,
    // 这条会红。修后计时落在真正的执行区间 → 应 ≳ 睡眠时长。阈值放宽到 20 避免调度抖动。
    expect(timing?.properties?.durationMs as number).toBeGreaterThanOrEqual(20);
  });
});
