import { Effect, Layer, Logger, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { driveRound } from "@/lib/server/sync/drive";

// 一轮同步在后台跑到底的那半(ADR 0048 之后没有观察流了,只有这条后台任务)。
// 纯逻辑:不引 cloudflare:workers、不认识 @folio/db、不认识 @folio/sync —— 所以能在这一层测。

const layerOf = (seen: string[]) =>
  Layer.merge(
    Layer.empty,
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        seen.push(String(message));
      }),
    ),
  );

describe("driveRound", () => {
  it("逐条落结果,跑完收官一次", async () => {
    const settled: string[] = [];
    const done: (string | null)[] = [];
    await driveRound(Stream.fromIterable(["a", "b"]), {
      layer: Layer.empty,
      onResult: (id) => Effect.sync(() => void settled.push(id)),
      onDone: (error) => Effect.sync(() => void done.push(error)),
    });
    expect(settled).toEqual(["a", "b"]);
    expect(done).toEqual([null]);
  });

  // 整轮没跑起来(取账户 / 取凭据挂了):一个结果都没有,那句话只能挂在收官上 ——
  // 不收官的话那一轮会一直「在跑」,直到 120s 后被判成中断,而它其实早就死透了。
  it("整轮失败也收官,并把那句话带上", async () => {
    const done: (string | null)[] = [];
    const fatal: string[] = [];
    await driveRound(
      Stream.fail({ message: "listAccounts failed" }) as Stream.Stream<
        string,
        { readonly message: string }
      >,
      {
        layer: Layer.empty,
        onResult: () => Effect.void,
        onDone: (error) => Effect.sync(() => void done.push(error)),
        onFatal: (m) => void fatal.push(m),
      },
    );
    expect(done).toEqual(["listAccounts failed"]);
    expect(fatal).toEqual(["listAccounts failed"]);
  });

  // 收官排在收尾之前,这个顺序是有代价换来的:反过来的话,面板要等一件与它无关的事
  //(预热缓存,可能在打一圈拿不到的上游)做完,才看得到「这一轮结束了」。
  it("先收官,再做收尾", async () => {
    const order: string[] = [];
    await driveRound(Stream.fromIterable(["a"]), {
      layer: Layer.empty,
      onResult: () => Effect.void,
      onDone: () => Effect.sync(() => void order.push("done")),
      afterRound: Effect.sync(() => void order.push("after")),
    });
    expect(order).toEqual(["done", "after"]);
  });

  it("收尾是尽力而为 —— 它炸了这一轮照样算跑完", async () => {
    const done: (string | null)[] = [];
    await expect(
      driveRound(Stream.fromIterable(["a"]), {
        layer: Layer.empty,
        onResult: () => Effect.void,
        onDone: (error) => Effect.sync(() => void done.push(error)),
        afterRound: Effect.die(new Error("warm exploded")),
      }),
    ).resolves.toBeUndefined();
    expect(done).toEqual([null]);
  });

  // **这条任务是另起的一条根 fiber,不继承外层的日志层。**根 fiber 拿的是默认 runtime,
  // 外层 `runAtEdge` 那次 `Effect.provide(logTapeLogger)` 对它无效 —— 所以同步与预热的
  // `Effect.log*` 想被接住,只能由**传进来那张 layer** 带上(生产里是 `syncRoundFor` 里
  // 那句 `Layer.merge(syncFor(…), logTapeLogger)`)。钉的是这个机制,不是 LogTape。
  it("同步与收尾的日志都落在传进来那张 layer 的 logger 上", async () => {
    const seen: string[] = [];
    await driveRound(
      Stream.fromIterable(["a"]).pipe(Stream.tap(() => Effect.logInfo("from-stream"))),
      {
        layer: layerOf(seen),
        onResult: () => Effect.void,
        onDone: () => Effect.void,
        afterRound: Effect.logInfo("from-afterRound"),
      },
    );
    expect(seen).toEqual(["from-stream", "from-afterRound"]);
  });
});
