import { describe, expect, it } from "vitest";
import { STALE_SYNC_MS, type SyncAccountInput, summarizeSync } from "@/lib/server/sync/status";

// 夹具默认「已同步过」(takenAt 有值)——「从未同步」必须由用例显式写出来,
// 否则整张表会默默漂进那一档,而那正是本文件上一版把 bug 固化住的方式:
// 默认 takenAt: null,却断言 ok=2。
//
// `now` 是显式参数,这个当下**紧挨着**下面那些 takenAt(100 / 1000 / 2000…),于是不关心
// 「旧不旧」的用例里 attention 只会装真问题;换个遥远的 now 会让整张表默默漂进「数旧了」那档。
const NOW = 5_000;

const acc = (over: Partial<SyncAccountInput>): SyncAccountInput => ({
  id: crypto.randomUUID(),
  label: "wallet",
  connectorId: "evm",
  archivedAt: null,
  complete: true,
  takenAt: 1000,
  ...over,
});

describe("summarizeSync", () => {
  it("counts ok = accounts that have actually synced", () => {
    const s = summarizeSync([acc({ takenAt: 1000 }), acc({ takenAt: 2000 })], NOW);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(2);
    expect(s.attention).toEqual([]);
  });

  // UI 说的是「Sources synced」。一个刚加进来、凭据齐全、但一次都没拉过数据的账户
  // 曾被算进 ok,于是面板显示「All synced 2/2」而账户行上写着「Never synced」。
  it("a never-synced account is not ok, even with complete creds", () => {
    const s = summarizeSync(
      [
        acc({ id: "a", label: "regression evm", takenAt: null }),
        acc({ id: "b", label: "H1", takenAt: 1000 }),
      ],
      NOW,
    );
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.attention).toEqual([
      {
        id: "a",
        label: "regression evm",
        connectorId: "evm",
        kind: "never-synced",
        takenAt: null,
      },
    ]);
  });

  it("lists incomplete-cred accounts and drops them from ok", () => {
    const s = summarizeSync(
      [acc({ id: "a", label: "Zerion", complete: false }), acc({ id: "b", label: "OKX" })],
      NOW,
    );
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.attention.map((a) => [a.id, a.kind])).toEqual([["a", "missing-credentials"]]);
  });

  // 两个毛病都有 → 只报一条,报根因:凭据都没配齐,「从未同步」是它的后果而非独立问题。
  it("reports missing creds once, not twice, when it also never synced", () => {
    const s = summarizeSync([acc({ id: "a", complete: false, takenAt: null })], NOW);
    expect(s.ok).toBe(0);
    expect(s.attention.map((a) => a.kind)).toEqual(["missing-credentials"]);
  });

  it("keeps ok + 「没有数」的条数 === total(数旧了的仍算 ok)", () => {
    const s = summarizeSync(
      [acc({ complete: false }), acc({ takenAt: null }), acc({ takenAt: 4000 })],
      NOW,
    );
    expect(s.ok + s.attention.filter((a) => a.kind !== "stale").length).toBe(s.total);
    expect(s.ok).toBe(1);
  });

  it("excludes archived accounts from every tally", () => {
    const s = summarizeSync(
      [acc({ id: "a", takenAt: 100 }), acc({ id: "z", archivedAt: 5, complete: false })],
      NOW,
    );
    expect(s.total).toBe(1);
    expect(s.accounts).toEqual([{ id: "a", label: "wallet" }]);
    expect(s.attention).toEqual([]);
    // 归档账户的 takenAt(1000)不得污染 lastSyncedAt
    expect(s.lastSyncedAt).toBe(100);
  });

  it("takes the newest snapshot time across active accounts", () => {
    const s = summarizeSync(
      [acc({ takenAt: 100 }), acc({ takenAt: 300 }), acc({ takenAt: null })],
      NOW,
    );
    expect(s.lastSyncedAt).toBe(300);
  });

  it("lastSyncedAt is null when no active account has ever synced", () => {
    const s = summarizeSync([acc({ takenAt: null }), acc({ takenAt: null })], NOW);
    expect(s.lastSyncedAt).toBeNull();
  });

  it("handles an empty account set", () => {
    const s = summarizeSync([], NOW);
    expect(s).toEqual({ accounts: [], total: 0, ok: 0, attention: [], lastSyncedAt: null });
  });

  // 「同步过、但数旧了」这一档(#527 裁定 8)。以前一周没同步的账户在摘要里一切正常,
  // 首页那个总资产是旧数而屏幕上没有任何提示。
  describe("数旧了(stale)", () => {
    const now = 1_000_000_000_000;
    const old = (over: Partial<SyncAccountInput>) => acc({ takenAt: now - 1000, ...over });

    it("刚过阈值 → 进清单,但仍然算 ok(它有数,只是旧)", () => {
      const s = summarizeSync(
        [old({ id: "a", label: "OKX", takenAt: now - STALE_SYNC_MS - 1 })],
        now,
      );
      expect(s.attention.map((a) => [a.id, a.kind])).toEqual([["a", "stale"]]);
      expect(s.ok).toBe(1);
    });

    it("恰好卡在阈值上 → 还不算旧(边界不含)", () => {
      const s = summarizeSync([old({ takenAt: now - STALE_SYNC_MS })], now);
      expect(s.attention).toEqual([]);
    });

    it("清单按严重程度排:缺凭据 → 从未同步 → 数旧了", () => {
      const s = summarizeSync(
        [
          old({ id: "stale", takenAt: now - 10 * STALE_SYNC_MS }),
          old({ id: "never", takenAt: null }),
          old({ id: "creds", complete: false }),
        ],
        now,
      );
      expect(s.attention.map((a) => a.id)).toEqual(["creds", "never", "stale"]);
    });

    it("同档内越旧的越前", () => {
      const s = summarizeSync(
        [
          old({ id: "较新", takenAt: now - 2 * STALE_SYNC_MS }),
          old({ id: "最旧", takenAt: now - 9 * STALE_SYNC_MS }),
        ],
        now,
      );
      expect(s.attention.map((a) => a.id)).toEqual(["最旧", "较新"]);
    });

    it("缺凭据的不会同时又报一条「数旧了」—— 一个账户只出现一次", () => {
      const s = summarizeSync(
        [old({ id: "a", complete: false, takenAt: now - 10 * STALE_SYNC_MS })],
        now,
      );
      expect(s.attention.map((a) => a.kind)).toEqual(["missing-credentials"]);
    });

    it("归档账户不进清单(它根本不参与同步)", () => {
      const s = summarizeSync([old({ archivedAt: 1, takenAt: now - 10 * STALE_SYNC_MS })], now);
      expect(s.attention).toEqual([]);
      expect(s.total).toBe(0);
    });
  });
});
