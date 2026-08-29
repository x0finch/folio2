import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitFirstCompute, POLL_INTERVAL } from "@/lib/queries/constants";

// FOL-36:总览与 tab 条改成读预计算之后,「还没算过」的响应是一份**空的**视图 + `pending` ——
// 而空视图与「这个组合真的一分钱都没有」在屏幕上长得一模一样。取数那层因此在这一下先等一等,
// 而不是把「还不知道」交成一排 0。这条钉的就是那个等待:等谁、等多久、什么时候不等。

interface Reply {
  pending?: true;
  total: number;
}

const empty = (r: Reply) => r.total === 0;

/** 把整段跑完:虚拟时钟一路推到底(每次推进之间冲微任务),不赌墙上时钟。 */
const runToEnd = async <A>(p: Promise<A>): Promise<A> => {
  await vi.advanceTimersByTimeAsync(120_000);
  return p;
};

describe("awaitFirstCompute", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("补算落地了就交卷 —— 不多等一拍", async () => {
    vi.useFakeTimers();
    const replies: Reply[] = [
      { pending: true, total: 0 },
      { pending: true, total: 0 },
      { total: 600 },
    ];
    const fetch = vi.fn(async () => replies.shift() ?? { total: 600 });

    const out = await runToEnd(awaitFirstCompute(fetch, empty, new AbortController().signal));

    expect(out).toEqual({ total: 600 });
    expect(fetch).toHaveBeenCalledTimes(3); // 空 → 空 → 有数,拿到就停
  });

  it("手上有旧值就立刻交卷,哪怕还标着 pending —— 旧的数字也是真的", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 100 }));

    const out = await runToEnd(awaitFirstCompute(fetch, empty, new AbortController().signal));

    expect(out).toEqual({ pending: true, total: 100 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("一直算不出来 → 用完次数就交出空态,不把页面永远挂在骨架上", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 0 }));

    const out = await runToEnd(awaitFirstCompute(fetch, empty, new AbortController().signal));

    expect(out).toEqual({ pending: true, total: 0 });
    // 首发 + 四次重问 = 五次。**上限必须存在**:没有它,一份永远算不出来的数据就是一张死页面。
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("退避,不是定频 —— 第一拍就是 `POLL_INTERVAL.precompute`", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 0 }));

    const p = awaitFirstCompute(fetch, empty, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.precompute);
    expect(fetch).toHaveBeenCalledTimes(2);
    // 第二拍是双倍:再推同样长的一段,不该又来一发。
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.precompute - 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await runToEnd(p);
  });

  it("查询被取消 → 当场停手,不留一条循环在后台接着打服务器", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 0 }));
    const ctrl = new AbortController();

    const p = awaitFirstCompute(fetch, empty, ctrl.signal);
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort(new Error("cancelled"));

    await expect(p).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1); // 取消之后一发都没有
  });
});
