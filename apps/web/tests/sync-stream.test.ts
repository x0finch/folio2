import { describe, expect, it } from "vitest";
import { ndjson, readSyncStream, SyncStreamError } from "@/lib/hooks/use-account-sync";

// 把若干块字节喂成一个 ReadableStream —— 分片边界故意切在行中间,模拟真实网络。
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}
const responseOf = (chunks: string[]) =>
  new Response(streamOf(chunks), { status: 200 }) as Response;

describe("ndjson", () => {
  it("行被分片切断也能还原", async () => {
    const out: unknown[] = [];
    for await (const line of ndjson(streamOf(['{"a":1}\n{"b', '":2}\n']))) out.push(line);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("末行没有换行也不丢", async () => {
    const out: unknown[] = [];
    for await (const line of ndjson(streamOf(['{"a":1}']))) out.push(line);
    expect(out).toEqual([{ a: 1 }]);
  });
});

describe("readSyncStream", () => {
  const opts = (onProgress = () => {}) => ({
    total: 3,
    labelOf: (id: string) => `label-${id}`,
    onProgress,
  });

  it("逐条回调,skipped 不算失败", async () => {
    const seen: number[] = [];
    const final = await readSyncStream(
      responseOf([
        '{"accountId":"a","ok":true}\n',
        '{"accountId":"b","ok":false,"skipped":true}\n',
        '{"accountId":"c","ok":true}\n',
      ]),
      opts(((p: { done: number }) => void seen.push(p.done)) as () => void),
    );
    expect(seen).toEqual([1, 2, 3]); // 三次回调,不是攒到最后一次
    expect(final.done).toBe(3);
    expect(final.failures).toEqual([]);
    // skipped 单独计数:它进 done(处理完)但没产出快照,面板的合成分子要刨掉它。
    expect(final.skipped).toBe(1);
  });

  it("失败收进 failures,带 accountId", async () => {
    const final = await readSyncStream(
      responseOf([
        '{"accountId":"a","ok":false,"error":"boom"}\n',
        '{"accountId":"b","ok":true}\n',
      ]),
      opts(),
    );
    expect(final.failures).toEqual([{ accountId: "a", error: "boom" }]);
    expect(final.done).toBe(2); // 失败的也算「跑过了」
    expect(final.skipped).toBe(0); // 失败 ≠ 跳过:失败账户往往仍有旧快照,分子不刨它
  });

  it("用户级失败(fatal)→ 抛,让调用方走错误分支", async () => {
    await expect(
      readSyncStream(responseOf(['{"fatal":"listAccounts failed"}\n']), opts()),
    ).rejects.toBeInstanceOf(SyncStreamError);
  });

  it("非 2xx → 抛", async () => {
    await expect(
      readSyncStream(new Response("nope", { status: 401 }), opts()),
    ).rejects.toBeInstanceOf(SyncStreamError);
  });
});
