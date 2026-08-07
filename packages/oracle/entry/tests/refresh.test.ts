import { UpstreamRateLimitError } from "@folio/client-core";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { swr } from "../src/refresh";

// SWR 编排是全层唯一知道「读本地 → 判 stale → 回源 → 写回」的地方(ADR 0023)。
// 它的语义在这里测一次,价 / 历史价 / warm 三处就不用各测一遍。
describe("swr", () => {
  const hit = (value: string, stale: boolean) => Effect.succeed(Option.some({ value, stale }));
  const miss = Effect.succeed(Option.none<{ value: string; stale: boolean }>());
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e);

  it("新鲜 → 直接回,不碰上游、不写回", async () => {
    const fetch = vi.fn(() => Effect.succeed(Option.some("new")));
    const write = vi.fn(() => Effect.void);
    const got = await run(hit("fresh", false).pipe(swr("t", Effect.suspend(fetch), write)));
    expect(got).toEqual(Option.some("fresh"));
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("stale → 回源 → 写回 → 回新值", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(
      hit("old", true).pipe(swr("t", Effect.succeed(Option.some("new")), write)),
    );
    expect(got).toEqual(Option.some("new"));
    expect(write).toHaveBeenCalledWith("new");
  });

  it("miss → 回源 → 写回", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(miss.pipe(swr("t", Effect.succeed(Option.some("new")), write)));
    expect(got).toEqual(Option.some("new"));
    expect(write).toHaveBeenCalledOnce();
  });

  it("上游没有 → 把旧值原样给出去,不写回(过期不删)", async () => {
    const write = vi.fn(() => Effect.void);
    const got = await run(hit("old", true).pipe(swr("t", Effect.succeed(Option.none()), write)));
    expect(got).toEqual(Option.some("old"));
    expect(write).not.toHaveBeenCalled();
  });

  it("上游失败也算「没有」→ 降级到本地,不向上抛", async () => {
    const boom = Effect.fail(
      new UpstreamRateLimitError({ upstream: "src", where: "/x", status: 429 }),
    );
    expect(await run(hit("old", true).pipe(swr("t", boom, () => Effect.void)))).toEqual(
      Option.some("old"),
    );
    // 连旧值都没有 → none,调用方降级
    expect(await run(miss.pipe(swr("t", boom, () => Effect.void)))).toEqual(Option.none());
  });

  // 迁移前 `fetch` 那一步是 `try { … } catch { }`,于是**自己的 bug 与上游限流长得一模一样**,
  // 一起被吞掉。现在只接 `UpstreamError`(类型化的四类),defect 照样炸出来。
  it("**自己的 bug 不吞** —— defect 一路冒上去,不当成「上游没有」", async () => {
    const bug = Effect.sync<Option.Option<string>>(() => {
      throw new TypeError("undefined is not a function");
    });
    await expect(run(hit("old", true).pipe(swr("t", bug, () => Effect.void)))).rejects.toThrow(
      /not a function/,
    );
  });
});
