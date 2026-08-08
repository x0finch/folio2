import { configure, type LogRecord } from "@logtape/logtape";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { logTapeLogger } from "../src/lib/server/internal/effect-log";

// 参考层的降级与告警走 Effect 自己的日志系统,而「落到哪」由这个转发器决定(见 effect-log.ts)。
// 它跑在**错误路径**上 —— 降级时才被调到 —— 所以它自己坏掉最难发现:上游挂了本该记一行,
// 结果记日志这一步先抛,把一次降级变成一次 500。这一组就是钉它。

const captured: LogRecord[] = [];

beforeAll(async () => {
  await configure({
    reset: true,
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{ category: ["folio"], sinks: ["capture"], lowestLevel: "debug" }],
  });
});

const run = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(Effect.provide(effect, logTapeLogger));

describe("Effect 日志 → LogTape", () => {
  it("warning + annotations → LogTape 的 warning + properties", async () => {
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

  it("level 分三档:error / warning / 其余归 info", async () => {
    captured.length = 0;
    await run(
      Effect.all([
        Effect.logError("boom"),
        Effect.logWarning("careful"),
        Effect.logInfo("fyi"),
        // `logDebug` 到不了这个转发器 —— Effect 自己的最低级别默认是 Info,它在上一道就被挡了。
        // (要放它过来得 `Logger.withMinimumLogLevel`;本仓不需要。)
        Effect.logDebug("noise"),
      ]),
    );
    expect(captured.map((r) => r.level)).toEqual(["error", "warning", "info"]);
  });

  it("没有 annotations 也不炸(properties 是空对象)", async () => {
    captured.length = 0;
    await run(Effect.logWarning("bare"));
    expect(captured[0]?.properties).toEqual({});
  });
});
