import type { SyncRoundAccount, SyncRoundRecord } from "@folio/db";
import { describe, expect, it } from "vitest";
import { syncRoundView } from "@/lib/server/sync/status";

// 「这一轮怎么样了」的判读(ADR 0048)。纯函数,喂数据就能断言 —— 它管的是三件容易含混的事:
//   · 在跑 / 中断 / 收官怎么分(中断 = 未收官且心跳断了,不是另一种失败)
//   · 三段式口径(synced · failed · need keys 各管各的,谁也不吞谁)
//   · 「正在同步谁」
//
// `now` 是显式参数,不在函数里读时钟:这里要断言「恰好卡在到期那一刻」这种精确边界。

const NOW = 1_700_000_000_000;

const account = (label: string, over: Partial<SyncRoundAccount> = {}): SyncRoundAccount => ({
  label,
  status: "pending",
  ...over,
});

const record = (over: Partial<SyncRoundRecord> = {}): SyncRoundRecord => ({
  roundId: "r1",
  portfolioId: "pf-1",
  trigger: "manual",
  startedAt: NOW - 5_000,
  finishedAt: null,
  accounts: {
    "acc-1": account("Binance"),
    "acc-2": account("Kraken"),
    "acc-3": account("Bybit"),
  },
  expiresAt: NOW + 120_000,
  ...over,
});

describe("这一轮是什么状态", () => {
  it("未收官、心跳还在 → 在跑", () => {
    expect(syncRoundView(record(), NOW).state).toBe("running");
  });

  it("收过官 → 收官(哪怕早就过了保留期)", () => {
    const view = syncRoundView(record({ finishedAt: NOW - 1_000, expiresAt: NOW - 500 }), NOW);
    expect(view.state).toBe("done");
  });

  // worker 死了没人再续心跳。这一条是整个心跳机制存在的理由:没有它,一轮假同步会永远显示「在跑」。
  it("未收官且心跳断了 → 中断", () => {
    expect(syncRoundView(record({ expiresAt: NOW - 1 }), NOW).state).toBe("interrupted");
  });

  it("到期那一刻就算断(`<=`,与开轮的覆盖判据同一条)", () => {
    expect(syncRoundView(record({ expiresAt: NOW }), NOW).state).toBe("interrupted");
  });
});

describe("三段式口径", () => {
  it("三段各管各的 —— 失败不算已同步,缺凭据也不算失败", () => {
    const view = syncRoundView(
      record({
        finishedAt: NOW,
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "failed", error: "401 from upstream" }),
          "acc-3": account("Bybit", { status: "needs-keys" }),
        },
      }),
      NOW,
    );
    expect(view.synced).toBe(1);
    expect(view.needsKeys).toBe(1);
    expect(view.failed).toEqual([
      { accountId: "acc-2", label: "Kraken", error: "401 from upstream" },
    ]);
  });

  it("失败缺原话时仍要有一句可显示的 —— 面板不能出现空白行", () => {
    const view = syncRoundView(
      record({ accounts: { "acc-1": account("Binance", { status: "failed" }) } }),
      NOW,
    );
    expect(view.failed[0]?.error).toBeTruthy();
  });

  it("`x / N` 数的是「有结果的 / 一共几个」,没轮到的不算", () => {
    const view = syncRoundView(
      record({
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken", { status: "failed", error: "boom" }),
          "acc-3": account("Bybit"),
        },
      }),
      NOW,
    );
    expect(view.settled).toBe(2);
    expect(view.total).toBe(3);
  });

  // 「整轮没跑起来」是轮头上的一句话,不是某个账户的失败 —— 那时一个账户结果都没有。
  it("整轮失败那一句原样带出来", () => {
    const view = syncRoundView(record({ finishedAt: NOW, error: "account store exploded" }), NOW);
    expect(view.error).toBe("account store exploded");
    expect(view.failed).toEqual([]);
  });

  it("没有整轮失败 → error 是 null,不是 undefined", () => {
    expect(syncRoundView(record(), NOW).error).toBeNull();
  });
});

describe("正在同步谁", () => {
  it("还没轮到的第一个 —— 轮询看到的就是这个", () => {
    const view = syncRoundView(
      record({
        accounts: {
          "acc-1": account("Binance", { status: "synced" }),
          "acc-2": account("Kraken"),
          "acc-3": account("Bybit"),
        },
      }),
      NOW,
    );
    expect(view.current).toBe("Kraken");
  });

  it("全都有结果了 → 没有「正在同步谁」", () => {
    const view = syncRoundView(
      record({ accounts: { "acc-1": account("Binance", { status: "synced" }) } }),
      NOW,
    );
    expect(view.current).toBeNull();
  });

  it("一个账户都没有的一轮 → 分母 0,不炸", () => {
    const view = syncRoundView(record({ accounts: {}, finishedAt: NOW }), NOW);
    expect(view.total).toBe(0);
    expect(view.settled).toBe(0);
    expect(view.current).toBeNull();
  });
});
