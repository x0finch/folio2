import { Effect, Layer, Logger, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ndjsonRound } from "@/lib/server/sync/ndjson";

// **`run` 是另起的一条根 fiber,不继承外层的日志层。**
//
// `ndjsonRound` 里那个后台任务由它自己的 `Effect.runPromise` 起(「一个程序一个边缘,这里恰好
// 有两个」),而根 fiber 拿的是默认 runtime —— 外层 `runAtEdge` 那次 `Effect.provide(logTapeLogger)`
// 对它无效。所以同步与预热的 `Effect.log*` 想被接住,只能由**传进来那张 layer** 带上
//(生产里就是 `syncRoundFor` 里那句 `Layer.merge(syncFor(userId), logTapeLogger)`)。
//
// 这条钉的是那个机制,不是 LogTape:换一个记数的 logger 就够,而且不必碰真日志系统。
describe("ndjsonRound 的后台任务", () => {
  it("流与收尾的日志都落在传进来那张 layer 的 logger 上", async () => {
    const seen: string[] = [];
    const collect = Layer.merge(
      Layer.empty,
      Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ message }) => {
          seen.push(String(message));
        }),
      ),
    );

    const { run } = await Effect.runPromise(
      ndjsonRound(
        Stream.fromIterable([{ ok: true }]).pipe(Stream.tap(() => Effect.logInfo("from-stream"))),
        { layer: collect, afterRound: Effect.logInfo("from-afterRound") },
      ),
    );
    await run;

    expect(seen).toEqual(["from-stream", "from-afterRound"]);
  });
});
