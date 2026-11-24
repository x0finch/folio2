import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoundView } from "@/lib/server/sync/status";

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
  skipped: 0,
  current: "Kraken",
  unresolved: 0,
  error: null,
  statuses: {},
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
    switchTo: (pf: string) => view.rerender(wrapper(pf)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSyncRound", () => {
  it("running = busy, clicking the button does nothing", async () => {
    getSyncRound.mockResolvedValue(view());
    const { api } = mountHook();
    await waitFor(() => expect(api.current.busy).toBe(true));
    expect(api.current.disabled).toBe(true);
    expect(api.current.round?.current).toBe("Kraken");
  });

  it("a finalized round is not busy; clickable when there are syncable accounts", async () => {
    getSyncRound.mockResolvedValue(view({ state: "done", finishedAt: 1, settled: 3 }));
    const { api } = mountHook();
    await waitFor(() => expect(api.current.round).not.toBeNull());
    expect(api.current.busy).toBe(false);
    expect(api.current.disabled).toBe(false);
  });

  it("this portfolio has no syncable accounts: not clickable", async () => {
    getSyncRound.mockResolvedValue(null);
    const { api } = mountHook("pf-1", 0);
    await waitFor(() => expect(api.current).not.toBeNull());
    expect(api.current?.disabled).toBe(true);
  });

  describe("when to refresh data", () => {
    it("first sight of a round does not refresh: it is just an old record present at page load", async () => {
      getSyncRound.mockResolvedValue(view({ state: "done", finishedAt: 1, settled: 3 }));
      const { api, client } = mountHook();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await waitFor(() => expect(api.current.round).not.toBeNull());
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("same data again: no refresh (polling yields a new object each time)", async () => {
      getSyncRound.mockResolvedValue(view());
      const { api, client } = mountHook();
      await waitFor(() => expect(api.current.round).not.toBeNull());
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        await client.refetchQueries();
      });
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("switching portfolio shows another round: no refresh (not progress, a different topic)", async () => {
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

      getSyncRound.mockResolvedValue(view({ roundId: "rA", state: "done", finishedAt: 1 }));
      switchTo("pf-a");
      await waitFor(() => expect(api.current.round?.roundId).toBe("rA"));
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("progress advances one step: refreshes the data domain once, without rereading the round itself", async () => {
      getSyncRound.mockResolvedValue(view({ settled: 1 }));
      const { api, client } = mountHook();
      await waitFor(() => expect(api.current.round?.settled).toBe(1));
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const readsBefore = getSyncRound.mock.calls.length;
      getSyncRound.mockResolvedValue(view({ settled: 2, synced: 2 }));
      await act(async () => {
        await client.refetchQueries();
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalled());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(getSyncRound.mock.calls.length).toBe(readsBefore + 1);
    });

    it("the start response is a new finalized round: the panel reads it, not overwritten by the stale round from the GET", async () => {
      getSyncRound.mockResolvedValue(view({ roundId: "r-old", state: "done", finishedAt: 1 }));
      const fresh = view({ roundId: "r-new", state: "done", finishedAt: 2, settled: 3 });
      global.fetch = vi.fn(
        async () => new Response(JSON.stringify(fresh), { status: 200 }),
      ) as unknown as typeof fetch;
      const { api } = mountHook();
      await waitFor(() => expect(api.current.round?.roundId).toBe("r-old"));
      const readsBefore = getSyncRound.mock.calls.length;

      act(() => api.current.sync());
      await waitFor(() => expect(api.current.round?.roundId).toBe("r-new"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(api.current.round?.roundId).toBe("r-new");
      expect(getSyncRound.mock.calls.length).toBe(readsBefore);
    });
  });
});

describe("auto catch-up sync on entering home", () => {
  const HOUR = 60 * 60 * 1000;
  const okFetch = () =>
    vi.fn(
      async () => new Response(JSON.stringify(view({ roundId: "auto" })), { status: 200 }),
    ) as unknown as typeof fetch;

  it("data stale (latest snapshot > 1 hour): starts a round automatically", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-due", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({ auto: true });
  });

  it("never synced (lastSyncedAt null): also syncs (a new user's first round)", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-never", 3, { lastSyncedAt: null });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });

  it("data still fresh (within 1 hour): does not sync", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-fresh", 3, { lastSyncedAt: Date.now() - 1000 });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("no autoSync passed (accounts / insights page): does not sync, even when data is very old", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-off", 3);
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("already syncing: does not sync (busy blocks it)", async () => {
    getSyncRound.mockResolvedValue(view({ state: "running" })); // busy
    global.fetch = okFetch();
    mountHook("auto-busy", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("no syncable accounts: does not sync", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-empty", 0, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("cooldown: remounting the same portfolio (remount / switching back) does not sync again", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = okFetch();
    mountHook("auto-cooldown", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    mountHook("auto-cooldown", 3, { lastSyncedAt: Date.now() - 2 * HOUR });
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("start failure message does not leak across portfolios", () => {
  it("start fails in portfolio A, switch to B: startError is cleared", async () => {
    getSyncRound.mockResolvedValue(null);
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const { api, switchTo } = mountHook("pf-a");
    await waitFor(() => expect(api.current).not.toBeNull());
    act(() => api.current.sync());
    await waitFor(() => expect(api.current.startError).toContain("network down"));

    switchTo("pf-b");
    await waitFor(() => expect(api.current.startError).toBeNull());
  });
});

describe("the two edges of starting", () => {
  it("start fails: invalidates the round query once so the page is not entirely stale", async () => {
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

  it("start succeeds: cancels the in-flight round query first, then lands the fresh one", async () => {
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
