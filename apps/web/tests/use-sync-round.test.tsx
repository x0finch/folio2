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
vi.mock("@/lib/server/sync", () => ({ getSyncRound }));

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
  unresolved: 0,
  error: null,
  ...over,
});

function mountHook(
  portfolioId = "pf-1",
  syncableCount = 3,
  autoSync?: { lastSyncedAt: number | null },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = { current: null as Api | null };
  function Probe({ pf }: { pf: string }) {
    api.current = useSyncRound(pf, syncableCount, autoSync);
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

describe("进首页自动补同步(FOL-18 子票 2)", () => {
  const HOUR = 60 * 60 * 1000;
  // 发起走 POST /api/sync;自动补与手动点共用同一发,所以「补没补」= fetch 被没被调。
  const okFetch = () =>
    vi.fn(
      async () => new Response(JSON.stringify(view({ roundId: "auto" })), { status: 200 }),
    ) as unknown as typeof fetch;

  it("数据过期(最新快照 > 1 小时)→ 自动补一轮", async () => {
    getSyncRound.mockResolvedValue(null); // 无在跑的轮 → 不 busy
    global.fetch = okFetch();
    mountHook("auto-due", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("从没同步过(lastSyncedAt null)→ 也补(新用户第一轮)", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-never", 3, { lastSyncedAt: null });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });

  it("数据还新(1 小时内)→ 不补", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-fresh", 3, { lastSyncedAt: Date.now() - 1000 });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("没传 autoSync(账户页 / 洞察页)→ 不补,哪怕数据很旧", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-off", 3); // 不传第三个参数
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("正在同步 → 不补(busy 挡住)", async () => {
    getSyncRound.mockResolvedValue(view({ state: "running" })); // busy
    global.fetch = okFetch();
    mountHook("auto-busy", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("没有可同步的账户 → 不补", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-empty", 0, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("冷却:同一组合再挂一次(重挂 / 切回来)不重复补", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-cooldown", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    // 换个新 client 重挂同一个组合 —— autoFired 是新的,但模块级冷却挡住第二发。
    mountHook("auto-cooldown", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(1);
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

describe("发起那一下的两条边", () => {
  // POST 的响应丢了 ≠ 轮没开:服务端可能已经抢下这一轮、waitUntil 已经在跑。什么都不做的话
  // 面板对着旧数据坐着 —— 轮询没被叫醒(它只在读到 running 时自转)。补一发 refetch:
  // 真开了轮会读到 running,轮询随之恢复;真没开也只是多读一次空键。
  it("发起失败 → 补一发轮 query 的 invalidate,别让页面全旧", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const { api, client } = mountHook();
    await waitFor(() => expect(api.current).not.toBeNull());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => api.current.sync());
    await waitFor(() => expect(api.current.startError).toContain("network down"));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["sync", "round", "pf-1"] }),
      ),
    );
  });

  // POST 的回包与一发在飞的 GET 赛跑:GET 先出发(读的是开轮前的旧轮)、后到达 —— 它落地会把
  // 刚 set 进去的新轮盖回旧的。react-query 的标准手法:set 之前先 cancel 在飞的那发。
  it("发起成功 → 先取消在飞的轮 query,再落刚回来的那份", async () => {
    getSyncRound.mockResolvedValue(null);
    const opened = view({ roundId: "r-new", settled: 0 });
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify(opened), { status: 200 }),
    ) as unknown as typeof fetch;

    const { api, client } = mountHook();
    await waitFor(() => expect(api.current).not.toBeNull());
    const calls: string[] = [];
    vi.spyOn(client, "cancelQueries").mockImplementation(async () => {
      calls.push("cancel");
    });
    const setData = vi.spyOn(client, "setQueryData").mockImplementation(((...args: unknown[]) => {
      calls.push("set");
      return args[1];
    }) as never);

    act(() => api.current.sync());
    await waitFor(() => expect(setData).toHaveBeenCalled());
    expect(calls).toEqual(["cancel", "set"]);
  });
});
