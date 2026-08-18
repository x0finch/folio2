import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshThrottle, REFRESH_WINDOW_MS } from "../src/lib/hooks/use-account-sync";

// 假时钟推进,**只断言调用次数与顺序,不断言墙钟时间**(CODING.md:限频/时序测试别断言墙钟)。

describe("createRefreshThrottle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("第一个 bump 立刻触发 —— 面板马上有动静,不等一个窗口", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("窗口内的连发合并成一次尾随", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump(); // leading
    t.bump();
    t.bump();
    t.bump();
    expect(run).toHaveBeenCalledTimes(1); // 后三个还压着

    vi.advanceTimersByTime(REFRESH_WINDOW_MS);

    expect(run).toHaveBeenCalledTimes(2); // 三个合成一次尾随,不是三次
  });

  it("窗口过去(且期间没人 bump)之后,下一个 bump 重新是 leading", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump();
    vi.advanceTimersByTime(REFRESH_WINDOW_MS);
    expect(run).toHaveBeenCalledTimes(1); // 没有欠着的尾随 → 窗口空过

    t.bump();

    expect(run).toHaveBeenCalledTimes(2); // 立刻,不用再等一个窗口
  });

  it("flush 取消挂起的尾随并立刻补一次 —— 总次数不多不少", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump(); // leading
    t.bump(); // 欠一次尾随
    t.flush();
    expect(run).toHaveBeenCalledTimes(2);

    // 关键:被取消的那个定时器不许再补一次。
    vi.advanceTimersByTime(REFRESH_WINDOW_MS * 3);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("flush 之后的 bump 不再触发", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump();
    t.flush();
    const after = run.mock.calls.length;

    t.bump();
    vi.advanceTimersByTime(REFRESH_WINDOW_MS * 3);

    expect(run).toHaveBeenCalledTimes(after);
  });

  it("只有一个账户的一轮:恰好刷一次", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.bump();
    t.flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("一个 bump 都没有(用户级失败)→ flush 仍要刷一次", () => {
    // 整轮没跑起来,但服务端可能已经落了部分快照(waitUntil)—— 这时候更要刷。
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    t.flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("连着两个窗口都有账户完成 → 两批各刷一次,不是每个账户一次", () => {
    const run = vi.fn();
    const t = createRefreshThrottle(run);

    // 第一批:并发 6 一起回来。
    t.bump();
    for (let i = 0; i < 5; i++) t.bump();
    vi.advanceTimersByTime(REFRESH_WINDOW_MS);
    expect(run).toHaveBeenCalledTimes(2); // leading + 一次尾随

    // 第二批落在下一个窗口里。
    t.bump();
    t.bump();
    vi.advanceTimersByTime(REFRESH_WINDOW_MS);

    expect(run).toHaveBeenCalledTimes(3); // 8 个账户,3 次刷新
  });
});
