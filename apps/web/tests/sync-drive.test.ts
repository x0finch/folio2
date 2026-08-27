import { Clock, Effect, Layer, Logger, Stream, TestClock, TestContext } from "effect";
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

  // settle 走 DbClient,错误通道是 never —— 它真出错是 **defect**(D1 瞬时抖一下)。
  // 没有这层兜住的话:一次 settle 炸 → 剩余账户不跑、收官不写、waitUntil 里一条 unhandled
  // rejection,而这一轮其实只差一笔账没记上。账本不是主任务:记一行 warning,继续跑。
  it("某一条 onResult 炸了(defect)→ 剩余账户照跑,照样收官", async () => {
    const settled: string[] = [];
    const done: (string | null)[] = [];
    await driveRound(Stream.fromIterable(["a", "b", "c"]), {
      layer: Layer.empty,
      onResult: (id) =>
        id === "a" ? Effect.die(new Error("D1 hiccup")) : Effect.sync(() => void settled.push(id)),
      onDone: (error) => Effect.sync(() => void done.push(error)),
    });
    expect(settled).toEqual(["b", "c"]);
    // settle 落不上不是「整轮没跑起来」—— 收官照常,不带 fatal 那句。
    expect(done).toEqual([null]);
  });

  // 流本身 defect(不是类型化失败):同样必须收官 —— 不收官那一轮会显示「在跑」直到 120s 后
  // 被判成中断,而它早就死透了;fatal 也要有一笔日志,别静默。
  it("流 defect → 照样收官,带上那句话,fatal 有日志", async () => {
    const done: (string | null)[] = [];
    const fatal: string[] = [];
    await driveRound(
      Stream.fromEffect(Effect.die(new Error("kernel exploded"))) as Stream.Stream<
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
    expect(done).toHaveLength(1);
    expect(done[0]).toContain("kernel exploded");
    expect(fatal).toHaveLength(1);
  });

  // 收官自己也可能炸(finish 也走 DbClient)。那时确实没有更多可做的了 —— 但绝不能变成
  // waitUntil 里的 unhandled rejection:driveRound 返回的 Promise 永不 reject。
  it("onDone 炸了 → Promise 照样 resolve,不往 waitUntil 里漏 rejection", async () => {
    await expect(
      driveRound(Stream.fromIterable(["a"]), {
        layer: Layer.empty,
        onResult: () => Effect.void,
        onDone: () => Effect.die(new Error("finish exploded")),
      }),
    ).resolves.toBeUndefined();
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

  // keepalive:轮活着期间按固定间隔续心跳。**settle 顺带的续期不够**——cron 把全部组合的轮
  // 开好再共用一把闸跑,后排的轮在队里等的时候一个 settle 都没有,>120s 就被误判成中断、
  // 被下一次开轮覆盖,同一批账户跑两遍。「活着 = 不过期」必须与排队无关。
  //
  // 用 TestClock(layer 供进去,时间只在流里被显式拨动),断言**精确的**触发时刻。
  it("轮活着期间按间隔续期;轮一结束就停", async () => {
    const touched: number[] = [];
    await driveRound(
      Stream.fromIterable(["a"]).pipe(Stream.tap(() => TestClock.adjust("130 seconds"))),
      {
        layer: TestContext.TestContext,
        onResult: () => Effect.void,
        onDone: () => Effect.void,
        keepalive: {
          intervalMs: 60_000,
          run: Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() => void touched.push(now)),
          ),
        },
        // 收尾里再把钟拨很远:keepalive 若没随轮结束被中断,这里会多出 180s / 240s … 的触发。
        afterRound: TestClock.adjust("200 seconds"),
      },
    );
    expect(touched).toEqual([60_000, 120_000]);
  });

  it("keepalive 自己炸了(defect)不撕轮 —— 只是这一拍没续上", async () => {
    const done: (string | null)[] = [];
    await driveRound(
      Stream.fromIterable(["a"]).pipe(Stream.tap(() => TestClock.adjust("70 seconds"))),
      {
        layer: TestContext.TestContext,
        onResult: () => Effect.void,
        onDone: (error) => Effect.sync(() => void done.push(error)),
        keepalive: { intervalMs: 60_000, run: Effect.die(new Error("touch exploded")) },
      },
    );
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
