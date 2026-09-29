import { configure, type LogRecord } from "@logtape/logtape";
import { Effect, Runtime } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { logCategory, logTapeLogger, withLogTapeLogger } from "@/lib/server/effect-log";

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

// **两条装法,同一份断言**:layer(`logTapeLogger`,测试与 Layer 装配用)与直接改 FiberRefs 的
// `withLogTapeLogger`(`runtime.ts` 手搭的运行时用,FOL-83 第二轮)。两边任何一条行为分叉,
// 下面每一条都会在其中一边红。
const routes = {
  layer: <A>(effect: Effect.Effect<A>) => Effect.runPromise(Effect.provide(effect, logTapeLogger)),
  fiberRefs: <A>(effect: Effect.Effect<A>) =>
    Runtime.runPromise(
      Runtime.make({
        context: Runtime.defaultRuntime.context,
        fiberRefs: withLogTapeLogger(Runtime.defaultRuntime.fiberRefs),
        runtimeFlags: Runtime.defaultRuntime.runtimeFlags,
      }),
    )(effect),
};

describe.each(Object.entries(routes))("Effect 日志 → LogTape(%s)", (_route, run) => {
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

  it("level 四档各归各的,debug 不被抬成 info", async () => {
    captured.length = 0;
    await run(
      Effect.all([
        Effect.logError("boom"),
        Effect.logWarning("careful"),
        Effect.logInfo("fyi"),
        // debug 现在到得了 —— 这一层门限设的是 All,级别过滤交给 LogTape 自己的配置。
        Effect.logDebug("noise"),
      ]),
    );
    expect(captured.map((r) => r.level)).toEqual(["error", "warning", "info", "debug"]);
  });

  // 类目跟着日志走(#403 片 2)。以前 sync 想自带一层 `Logger.replace` 接自己的类目 —— 那不会
  // 顶掉外层那个,只会**两个都在**:每条日志写两遍,一遍还落错类目。这一组钉住新形状。
  it("标了 logCategory 就落那个类目,没标的落 oracle", async () => {
    captured.length = 0;
    await run(
      Effect.all([Effect.logInfo("synced").pipe(logCategory("sync")), Effect.logInfo("priced")]),
    );
    expect(captured.map((r) => r.category)).toEqual([
      ["folio", "sync"],
      ["folio", "oracle"],
    ]);
  });

  it("每条只写一遍,而且类目不进 properties", async () => {
    captured.length = 0;
    await run(Effect.logInfo("once").pipe(logCategory("sync")));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties).toEqual({});
  });

  it("没有 annotations 也不炸(properties 是空对象)", async () => {
    captured.length = 0;
    await run(Effect.logWarning("bare"));
    expect(captured[0]?.properties).toEqual({});
  });
});
