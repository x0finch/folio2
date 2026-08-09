import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 取价 hook 的竞态守卫(#428 片 5)。这份守卫以前在两个地方各抄了一遍(`use-token-price.ts` 与
// `account-fields.tsx`),这次合成一份 —— 合并的前提是它真的把两边的语义都覆盖了,所以这里钉住:
//
// ① 后发的请求先回来,先发的那次回来之后**不能**再往回填(否则用户选了 B、框里却是 A 的价);
// ② `cancel()` 之后,还在飞的那次回来同样不能填(转去手填 symbol / 清空选择走这条);
// ③ `busy` 只由「最后一次」收尾 —— 被作废的那次收 busy 会把新一轮的转圈提前关掉。
const { getTokenPrice } = vi.hoisted(() => ({ getTokenPrice: vi.fn() }));
vi.mock("../src/lib/server/tokens", () => ({ getTokenPrice }));

const { useTokenPrice } = await import("../src/lib/hooks/use-token-price");

type Api = ReturnType<typeof useTokenPrice>;

function mountHook() {
  const api = { current: null as Api | null };
  function Probe() {
    api.current = useTokenPrice();
    return null;
  }
  render(<Probe />);
  return api as { current: Api };
}

// 受控 promise:让测试自己决定哪一次先回来。
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTokenPrice 的竞态守卫", () => {
  it("命中就回填", async () => {
    getTokenPrice.mockResolvedValue({ unitPrice: 123 });
    const api = mountHook();
    const onPrice = vi.fn();

    await act(async () => {
      await api.current.fetchPrice("btc", onPrice);
    });

    expect(getTokenPrice).toHaveBeenCalledWith({ data: { ticket: "btc" } });
    expect(onPrice).toHaveBeenCalledWith(123);
  });

  it("先发的那次后回来 → 不许回填(否则会盖掉后选的那个币)", async () => {
    const first = deferred<{ unitPrice: number }>();
    const second = deferred<{ unitPrice: number }>();
    getTokenPrice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = mountHook();
    const onFirst = vi.fn();
    const onSecond = vi.fn();

    let firstDone!: Promise<void>;
    let secondDone!: Promise<void>;
    act(() => {
      firstDone = api.current.fetchPrice("btc", onFirst);
      secondDone = api.current.fetchPrice("eth", onSecond);
    });

    await act(async () => {
      second.resolve({ unitPrice: 20 });
      await secondDone;
      first.resolve({ unitPrice: 10 }); // 迟到的第一次
      await firstDone;
    });

    expect(onSecond).toHaveBeenCalledWith(20);
    expect(onFirst).not.toHaveBeenCalled();
  });

  it("cancel() 之后回来的那次也不许回填", async () => {
    const d = deferred<{ unitPrice: number }>();
    getTokenPrice.mockReturnValueOnce(d.promise);
    const api = mountHook();
    const onPrice = vi.fn();

    let done!: Promise<void>;
    act(() => {
      done = api.current.fetchPrice("btc", onPrice);
    });
    act(() => api.current.cancel());

    await act(async () => {
      d.resolve({ unitPrice: 10 });
      await done;
    });

    expect(onPrice).not.toHaveBeenCalled();
  });

  it("busy:发起时为真,落地后为假;cancel 立刻收掉", async () => {
    const d = deferred<{ unitPrice: number }>();
    getTokenPrice.mockReturnValueOnce(d.promise);
    const api = mountHook();
    expect(api.current.busy).toBe(false);

    let done!: Promise<void>;
    act(() => {
      done = api.current.fetchPrice("btc", vi.fn());
    });
    expect(api.current.busy).toBe(true);

    act(() => api.current.cancel());
    expect(api.current.busy).toBe(false);

    await act(async () => {
      d.resolve({ unitPrice: 10 });
      await done;
    });
    expect(api.current.busy).toBe(false);
  });

  // 被作废的那次不能替新一轮收 busy —— 否则「正在取价」的提示会提前消失,而新一次还在飞。
  it("被作废的那次回来,不会把新一轮的 busy 关掉", async () => {
    const first = deferred<{ unitPrice: number }>();
    const second = deferred<{ unitPrice: number }>();
    getTokenPrice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = mountHook();

    let firstDone!: Promise<void>;
    act(() => {
      firstDone = api.current.fetchPrice("btc", vi.fn());
    });
    act(() => {
      void api.current.fetchPrice("eth", vi.fn());
    });
    expect(api.current.busy).toBe(true);

    await act(async () => {
      first.resolve({ unitPrice: 10 });
      await firstDone;
    });

    expect(api.current.busy).toBe(true); // 第二次还在飞
    await act(async () => {
      second.resolve({ unitPrice: 20 });
    });
    expect(api.current.busy).toBe(false);
  });

  it("取价失败不抛出、也不回填", async () => {
    getTokenPrice.mockRejectedValue(new Error("boom"));
    const api = mountHook();
    const onPrice = vi.fn();

    await act(async () => {
      await api.current.fetchPrice("btc", onPrice);
    });

    expect(onPrice).not.toHaveBeenCalled();
    expect(api.current.busy).toBe(false);
  });
});
