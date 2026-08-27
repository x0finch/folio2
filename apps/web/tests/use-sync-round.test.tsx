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

function mountHook(portfolioId = "pf-1", syncableCount = 3) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = { current: null as Api | null };
  function Probe({ pf }: { pf: string }) {
    api.current = useSyncRound(pf, syncableCount);
    return null;
  }
  const wrapper = (pf: string): ReactNode => (
    <QueryClientProvider client={client}>
      <Probe pf={pf} />
    </QueryClientProvider>
  );
  const view = render(wrapper(portfolioId));
  return {
    api: api as { current: Api },
    client,
    /** 换一个组合再渲染 —— 「切组合」在这个 hook 上的形状。 */
    switchTo: (pf: string) => view.rerender(wrapper(pf)),
  };
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
    const { api } = mountHook("pf-1", 0);
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

    // 切组合 = 换一份轮。B 组合那份与 A 的 mark 当然不同,但那不是「进度前进了」——
    // 按旧 mark 一比就假刷一次全域,切几下组合就白拉几遍首页。切过去的第一眼永远走首见分支。
    it("切组合看到另一份轮 → 不刷(那不是进度,是换了个话题)", async () => {
      getSyncRound.mockResolvedValue(view({ roundId: "rA", state: "done", finishedAt: 1 }));
      const { api, client, switchTo } = mountHook("pf-a");
      await waitFor(() => expect(api.current.round?.roundId).toBe("rA"));

      const invalidate = vi.spyOn(client, "invalidateQueries");
      getSyncRound.mockResolvedValue(
        view({ roundId: "rB", state: "done", finishedAt: 1, settled: 3 }),
      );
      switchTo("pf-b");
      await waitFor(() => expect(api.current.round?.roundId).toBe("rB"));
      expect(invalidate).not.toHaveBeenCalled();

      // 切回来同理:A 那份还在缓存里,一挂上来就能读到 —— 它也不是进度。
      getSyncRound.mockResolvedValue(view({ roundId: "rA", state: "done", finishedAt: 1 }));
      switchTo("pf-a");
      await waitFor(() => expect(api.current.round?.roundId).toBe("rA"));
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

describe("发起失败那句话不串组合", () => {
  it("A 组合发起失败,切到 B → startError 清空", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const { api, switchTo } = mountHook("pf-a");
    await waitFor(() => expect(api.current).not.toBeNull());
    act(() => api.current.sync());
    await waitFor(() => expect(api.current.startError).toContain("network down"));

    // 那句话说的是「在 A 组合发起失败了」—— 挂在 B 的面板上就是对着 B 说 A 的事。
    switchTo("pf-b");
    await waitFor(() => expect(api.current.startError).toBeNull());
  });
});
