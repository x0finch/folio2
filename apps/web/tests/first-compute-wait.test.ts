import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitFirstCompute, POLL_INTERVAL, refetchUntil } from "@/lib/queries/constants";

// FOL-36:总览与 tab 条改成读预计算之后,「还没算过」的响应是一份**空的**视图 + `pending` ——
// 而空视图与「这个组合真的一分钱都没有」在屏幕上长得一模一样。取数那层因此在这一下先等一等,
// 而不是把「还不知道」交成一排 0。这条钉的就是那个等待:等谁、等多久、等不到怎么办。

interface Reply {
  pending?: true;
  total: number;
}

const empty = (r: Reply) => r.total === 0;

/**
 * 把整段跑完:虚拟时钟一路推到底(每次推进之间冲微任务),不赌墙上时钟。
 *
 * **先接住结果再推时钟** —— 推的过程里那条 promise 可能就已经 reject 了,而那一刻还没人接,
 * Node 会当成 unhandled rejection 报出来(用例照样绿,但每次跑都多两行噪音)。
 */
const runToEnd = async <A>(p: Promise<A>): Promise<A> => {
  const settled = p.then(
    (value) => () => value,
    (error) => () => {
      throw error;
    },
  );
  await vi.advanceTimersByTimeAsync(120_000);
  return (await settled)();
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

  it("真·空组合(算过了,就是没有东西)→ 空态照常交出去", async () => {
    vi.useFakeTimers();
    // 没有 `pending`:这份空是**算出来的**空,不是「还没算」。
    const fetch = vi.fn(async (): Promise<Reply> => ({ total: 0 }));

    const out = await runToEnd(awaitFirstCompute(fetch, empty, new AbortController().signal));

    expect(out).toEqual({ total: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("一直算不出来 → **报错**,绝不把空态当答案交出去", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 0 }));

    // 交出去的话:总额显示 0,而曲线**不是**预计算的、是真数据 —— 屏幕上一条真实资产曲线
    // 在「现在」直坠到零,旁边写着「还没有账户」。错得像真的,比一句「加载失败」糟得多。
    await expect(
      runToEnd(awaitFirstCompute(fetch, empty, new AbortController().signal)),
    ).rejects.toThrow("precompute not ready");
    // 首发 + 四次重问 = 五次。**上限必须存在**:没有它,页面永远挂在骨架上。
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("退避,不是定频 —— 第二拍要等的是双倍", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (): Promise<Reply> => ({ pending: true, total: 0 }));

    const p = awaitFirstCompute(fetch, empty, new AbortController().signal).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.precompute);
    expect(fetch).toHaveBeenCalledTimes(2);
    // **关键的一拍**:再推一个整档。定频的实现会在这里发第三发,退避的不会 ——
    // 少了这一步,一个恒为 1000ms 的实现也能让这条用例绿。
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.precompute);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL.precompute);
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it("取消发生在请求飞行期间 → 醒来之前就停,不再多打一次", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    // 这一发在飞的过程中查询被取消 —— `abort` 事件在我们挂钩子**之前**就过去了。
    // 不先问一句 `signal.aborted`,这一觉照睡,醒来再打一次服务器。
    const fetch = vi.fn(async (): Promise<Reply> => {
      ctrl.abort(new Error("cancelled"));
      return { pending: true, total: 0 };
    });

    const p = awaitFirstCompute(fetch, empty, ctrl.signal);

    await expect(runToEnd(p)).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// 写完之后「等界面真的变了」用的是同一套退避(见 `refetchUntil`)。钉一个自定义 Tab 之后要选中
// 它,而 tab 条是预计算出来的:写路径只抬水位线,紧跟着那次刷新拿回的还是**旧条子**。
describe("refetchUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("等到条件成立为止", async () => {
    vi.useFakeTimers();
    const pins = [["a"], ["a"], ["a", "b"]];
    const refetch = vi.fn(async () => pins.shift() ?? ["a", "b"]);

    const out = await runToEnd(refetchUntil(refetch, (p) => p.includes("b")));

    expect(out).toEqual(["a", "b"]);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("第一次就成立 → 不多问一次", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn(async () => ["a", "b"]);

    await runToEnd(refetchUntil(refetch, (p) => p.includes("b")));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("等不到就交出手上那份 —— 不抛、不永远等下去", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn(async () => ["a"]);

    // URL 仍是权威,轮询落地后界面自己会对齐;把用户永远挂在一个转圈的按钮上才是错的。
    const out = await runToEnd(refetchUntil(refetch, (p) => p.includes("b")));

    expect(out).toEqual(["a"]);
    expect(refetch).toHaveBeenCalledTimes(5);
  });
});
