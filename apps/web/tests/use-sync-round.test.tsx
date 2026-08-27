import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoundView } from "@/lib/server/sync/status";

// 前端这一侧只剩两件事:发起一轮,和读它(ADR 0048)。这里钉住的是**进度前进时才刷数据**
// 那条规则 —— 它写起来只有几行,坏起来完全不报错:
//   · 按对象身份刷 → 轮询每 1.5s 回一个新对象,于是每 1.5s 无条件重拉一遍首页;
//   · 首次看见就刷 → 每次挂载(每次换页)都白刷一遍,而那时数据本来就是新的。
const { getSyncRound } = vi.hoisted(() => ({ getSyncRound: vi.fn() }));
vi.mock("@/lib/server/sync", () => ({ getSyncRound, getSyncStatus: vi.fn() }));

const { useSyncRound } = await import("@/lib/hooks/use-sync-round");

type Api = ReturnType<typeof useSyncRound>;

const view = (over: Partial<SyncRoundView> = {}): SyncRoundView => ({
  roundId: "r1",
  state: "running",
  trigger: "manual",
  startedAt: 0,
  finishedAt: null,
  total: 3,
  settled: 1,
  synced: 1,
  failed: [],
  needsKeys: 0,
  current: "Kraken",
  error: null,
  ...over,
});

function mountHook() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = { current: null as Api | null };
  function Probe() {
    api.current = useSyncRound("pf-1", 3);
    return null;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrapper({ children: <Probe /> }));
  return { api: api as { current: Api }, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSyncRound", () => {
  it("在跑 = busy,按钮点了也没用", async () => {
    getSyncRound.mockResolvedValue(view());
    const { api } = mountHook();
    await waitFor(() => expect(api.current.busy).toBe(true));
    expect(api.current.disabled).toBe(true);
    expect(api.current.round?.current).toBe("Kraken");
  });

  it("收官的一轮不是 busy;有可同步的账户就点得动", async () => {
    getSyncRound.mockResolvedValue(view({ state: "done", finishedAt: 1, settled: 3 }));
    const { api } = mountHook();
    await waitFor(() => expect(api.current.round).not.toBeNull());
    expect(api.current.busy).toBe(false);
    expect(api.current.disabled).toBe(false);
  });

  it("这个组合没有可同步的账户 → 点不动", async () => {
    getSyncRound.mockResolvedValue(null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = { current: null as Api | null };
    function Probe() {
      api.current = useSyncRound("pf-1", 0);
      return null;
    }
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.current).not.toBeNull());
    expect(api.current?.disabled).toBe(true);
  });

  describe("什么时候刷数据", () => {
    it("首次看见一轮不刷 —— 那只是页面加载时这里有一份旧记录", async () => {
      getSyncRound.mockResolvedValue(view({ state: "done", finishedAt: 1, settled: 3 }));
      const { api, client } = mountHook();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await waitFor(() => expect(api.current.round).not.toBeNull());
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("同一份数据又回来一次 → 不刷(轮询每次都是新对象)", async () => {
      getSyncRound.mockResolvedValue(view());
      const { api, client } = mountHook();
      await waitFor(() => expect(api.current.round).not.toBeNull());
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        await client.refetchQueries();
      });
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("进度前进一格 → 刷一次", async () => {
      getSyncRound.mockResolvedValue(view({ settled: 1 }));
      const { api, client } = mountHook();
      await waitFor(() => expect(api.current.round?.settled).toBe(1));
      const invalidate = vi.spyOn(client, "invalidateQueries");
      getSyncRound.mockResolvedValue(view({ settled: 2, synced: 2 }));
      await act(async () => {
        await client.refetchQueries();
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalled());
    });
  });
});
