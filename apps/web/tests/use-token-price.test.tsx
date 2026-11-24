import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

//
const { getTokenPrice } = vi.hoisted(() => ({ getTokenPrice: vi.fn() }));
vi.mock("@/lib/server/tokens", () => ({ getTokenPrice }));

const { useTokenPrice } = await import("@/lib/hooks/use-token-price");

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

describe("useTokenPrice race guard", () => {
  it("hit: backfills", async () => {
    getTokenPrice.mockResolvedValue({ unitPrice: 123 });
    const api = mountHook();
    const onPrice = vi.fn();

    await act(async () => {
      await api.current.fetchPrice("btc", onPrice);
    });

    expect(getTokenPrice).toHaveBeenCalledWith({ data: { ticket: "btc" } });
    expect(onPrice).toHaveBeenCalledWith(123);
  });

  it("an earlier request returning later: must not backfill (it would overwrite the later-selected token)", async () => {
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
      first.resolve({ unitPrice: 10 });
      await firstDone;
    });

    expect(onSecond).toHaveBeenCalledWith(20);
    expect(onFirst).not.toHaveBeenCalled();
  });

  it("a request returning after cancel() must not backfill either", async () => {
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

  it("busy: true on start, false after landing; cancel clears it immediately", async () => {
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

  it("a superseded request returning does not clear the new round's busy", async () => {
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

    expect(api.current.busy).toBe(true);
    await act(async () => {
      second.resolve({ unitPrice: 20 });
    });
    expect(api.current.busy).toBe(false);
  });

  it("price fetch failure neither throws nor backfills", async () => {
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
