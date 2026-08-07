import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ndjsonRound } from "../src/lib/server/internal/sync-ndjson";

// /api/sync 的核心那一手:「跑」与「看」拆开(见 src/lib/sync-ndjson.ts)。
// 路由 handler 本身只剩鉴权 + 接依赖 + waitUntil,逻辑全在这个纯模块里,所以这里测得到。
//
// 唯一测不到的仍是「真的关掉标签页」—— 那要真实连接中断,单测造不出来,等 #372 的 e2e。
// 但**下面第三条是它最接近的代理**:没人读也能跑完。

const readLines = async (body: ReadableStream<Uint8Array>): Promise<string[]> => {
  const text = await new Response(body).text();
  return text.split("\n").filter((l) => l.length > 0);
};

const fail = (message: string) => Stream.fail({ message });

describe("ndjsonRound", () => {
  it("每个结果一行 JSON,顺序同流", async () => {
    const results = [
      { accountId: "a1", ok: true },
      { accountId: "a2", ok: false, error: "boom" },
    ];
    const { body, run } = await ndjsonRound(Stream.fromIterable(results));
    await run;
    expect((await readLines(body)).map((l) => JSON.parse(l))).toEqual(results);
  });

  it("用户级失败 → 末行是 { fatal },并记一笔", async () => {
    const onFatal = vi.fn();
    const { body, run } = await ndjsonRound(
      Stream.fromIterable([{ accountId: "a1", ok: true }]).pipe(
        Stream.concat(fail("listAccounts blew up")),
      ),
      { onFatal },
    );
    await run;
    const lines = (await readLines(body)).map((l) => JSON.parse(l));
    expect(lines).toEqual([{ accountId: "a1", ok: true }, { fatal: "listAccounts blew up" }]);
    expect(onFatal).toHaveBeenCalledWith("listAccounts blew up");
  });

  // 「关掉标签页同步照样跑完」的可单测代理:生产端跑完全程时**一个字节都没人读**。
  // 队列是无界的,所以它不该被卡住 —— 卡住的话这条会超时,而不是断言失败。
  it("没人读也跑完,之后再读仍拿到全部行", async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ accountId: `a${i}`, ok: true }));
    const { body, run } = await ndjsonRound(Stream.fromIterable(results));
    await run; // 此刻响应流一个字节都还没被读过
    expect(await readLines(body)).toHaveLength(20);
  });

  it("afterRound 在一轮之后跑;它抛错不影响已产出的结果(best-effort)", async () => {
    const order: string[] = [];
    const { body, run } = await ndjsonRound(
      Stream.fromIterable([{ accountId: "a1", ok: true }]).pipe(
        Stream.tap(() => Effect.sync(() => order.push("result"))),
      ),
      {
        afterRound: async () => {
          order.push("afterRound");
          throw new Error("warm failed");
        },
      },
    );
    await expect(run).resolves.toBeUndefined(); // 抛错被吞掉,run 正常结束
    expect(order).toEqual(["result", "afterRound"]);
    expect(await readLines(body)).toHaveLength(1);
  });

  // 顺序上更要紧的一条:**「看」不等收尾**。afterRound 是预热缓存那类与本轮结果无关的活,
  // 让响应流等它 = 结果早就全送到了,前端还停在「同步中」。#372 的 e2e 里量到过这个:
  // toast 停在「Syncing 2/2」,而成功 toast 迟迟不出,因为预热在打一圈拿不到的上游。
  it("afterRound 还没跑完,响应流就已经收工(「看」不等收尾)", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let warmed = false;
    const { body, run } = await ndjsonRound(Stream.fromIterable([{ accountId: "a1", ok: true }]), {
      afterRound: async () => {
        await held;
        warmed = true;
      },
    });

    // 读到 EOF 了(readLines 要读满整条流),而 afterRound 还被卡着。
    expect(await readLines(body)).toHaveLength(1);
    expect(warmed).toBe(false);

    release();
    await run;
    expect(warmed).toBe(true);
  });

  it("一轮之后队列关闭 → 响应流自然结束(不悬着)", async () => {
    const { body, run } = await ndjsonRound(Stream.empty);
    await run;
    expect(await readLines(body)).toEqual([]); // 读得到 EOF,不是卡住
  });
});
