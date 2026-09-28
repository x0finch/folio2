import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoundView } from "@/lib/server/sync/status";

// 单账户同步在前端这一侧(FOL-89):`syncAccount` 只排队、即返,「同步完了没有、结果是什么」从那一轮
// 里读。这里钉两件事:从一轮里念出**这个账户**的下场(纯函数),以及「发起 → 轮询 → 念出结果」那条循环
// 的形状(先落缓存、按间隔读、念得出就停)。
const { syncAccount, getSyncRound } = vi.hoisted(() => ({
  syncAccount: vi.fn(),
  getSyncRound: vi.fn(),
}));
vi.mock("@/lib/server/sync", () => ({ syncAccount, getSyncRound }));

const { accountOutcomeIn, syncAccountAndWait } = await import("@/lib/queries/account-sync");
const { syncKeys } = await import("@/lib/queries/keys");

const ACC = "acc-1";

const view = (over: Partial<SyncRoundView> = {}): SyncRoundView => ({
  roundId: "r1",
  state: "running",
  trigger: "manual",
  startedAt: 0,
  finishedAt: null,
  total: 1,
  settled: 0,
  synced: 0,
  failed: [],
  needsKeys: 0,
  skipped: 0,
  current: "Binance",
  unresolved: 0,
  error: null,
  statuses: { [ACC]: "pending" },
  ...over,
});

describe("accountOutcomeIn", () => {
  it("还 pending 且轮在跑 → null(接着等)", () => {
    expect(accountOutcomeIn(view(), "r1", ACC)).toBeNull();
  });

  it("四档落账各念成以前内联结果的那个形状", () => {
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "synced" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: true,
    });
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "needs-keys" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
    expect(accountOutcomeIn(view({ statuses: { [ACC]: "skipped" } }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
    });
    expect(
      accountOutcomeIn(
        view({
          statuses: { [ACC]: "failed" },
          failed: [{ accountId: ACC, label: "Binance", error: "binance 429" }],
        }),
        "r1",
        ACC,
      ),
    ).toEqual({ accountId: ACC, ok: false, error: "binance 429" });
  });

  it("轮中断了还没轮到它 → 失败(没有原话)", () => {
    expect(accountOutcomeIn(view({ state: "interrupted" }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
    });
  });

  it("轮被下一轮盖掉 / 读不到 → 静默跳过", () => {
    const skipped = { accountId: ACC, ok: false, skipped: true };
    expect(accountOutcomeIn(view({ roundId: "r2" }), "r1", ACC)).toEqual(skipped);
    expect(accountOutcomeIn(null, "r1", ACC)).toEqual(skipped);
  });

  it("轮收官了它还 pending(轮中被归档)→ 跳过", () => {
    expect(accountOutcomeIn(view({ state: "done", finishedAt: 1 }), "r1", ACC)).toEqual({
      accountId: ACC,
      ok: false,
      skipped: true,
    });
  });
});

describe("syncAccountAndWait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当场就有结果(手记 / 缺凭据)→ 原样返回,不轮询", async () => {
    const result = { accountId: ACC, ok: false, skipped: true, skipReason: "manual" };
    syncAccount.mockResolvedValue({ queued: false, result });
    const client = new QueryClient();

    await expect(syncAccountAndWait(client, ACC)).resolves.toEqual(result);
    expect(getSyncRound).not.toHaveBeenCalled();
  });

  it("排进了一轮 → 回包先落缓存,再按间隔读那一轮,直到它落账", async () => {
    const start = view();
    syncAccount.mockResolvedValue({
      queued: true,
      accountId: ACC,
      portfolioId: "pf-1",
      roundId: "r1",
      round: start,
    });
    getSyncRound.mockResolvedValueOnce(view({ settled: 0 })).mockResolvedValueOnce(
      view({
        state: "done",
        finishedAt: 1,
        settled: 1,
        synced: 1,
        statuses: { [ACC]: "synced" },
      }),
    );
    const client = new QueryClient();
    const seen: unknown[] = [];
    client.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action.type === "success") seen.push(e.query.state.data);
    });

    const outcome = await syncAccountAndWait(client, ACC, { pollMs: 1 });

    expect(outcome).toEqual({ accountId: ACC, ok: true });
    expect(seen[0]).toEqual(start); // 页头胶囊立刻有东西可画
    expect(getSyncRound).toHaveBeenCalledTimes(2);
    expect(getSyncRound).toHaveBeenCalledWith({ data: { portfolioId: "pf-1" } });
    expect(client.getQueryData(syncKeys.round("pf-1"))).toMatchObject({ state: "done" });
  });

  it("一直不落账 → 到点放弃,念成失败", async () => {
    syncAccount.mockResolvedValue({
      queued: true,
      accountId: ACC,
      portfolioId: "pf-1",
      roundId: "r1",
      round: view(),
    });
    getSyncRound.mockResolvedValue(view());
    const client = new QueryClient();

    await expect(syncAccountAndWait(client, ACC, { pollMs: 1, timeoutMs: 5 })).resolves.toEqual({
      accountId: ACC,
      ok: false,
    });
  });

  it("发起本身失败 → reject(调用方的 onError 那一支)", async () => {
    syncAccount.mockRejectedValue(new Error("network"));
    await expect(syncAccountAndWait(new QueryClient(), ACC)).rejects.toThrow("network");
  });
});
