import type { AccountSafe } from "@folio/db";
import { describe, expect, it } from "vitest";
import { type SyncDeps, syncAllUsers } from "../src";

// manual 账户(成功路径);bad-type 账户(无 provider → getProvider 抛 → syncAccount 捕获 → ok:false)。
function manual(id: string, userId: string): AccountSafe {
  return { id, userId, type: "manual", network: null, label: id, createdAt: 0 };
}
function badType(id: string, userId: string): AccountSafe {
  return { id, userId, type: "exchange_bybit", network: null, label: id, createdAt: 0 };
}

// 按 userId 返回各自账户的注入式 deps(syncAllUsers 用一个 deps 跑所有用户)。
function makeDeps(accountsByUser: Record<string, AccountSafe[]>): SyncDeps {
  return {
    listAccounts: async (userId) => accountsByUser[userId] ?? [],
    listRawCreds: async () => [],
    writeSnapshot: async (_u, accountId) => `snap-${accountId}`,
    // manual → ok;未知 type(无 provider)→ 抛(模拟 balances.fetchBalances 内 getProvider 兜底报错)。
    fetchBalances: async (account) => {
      if (account.type === "manual") return { status: "ok", balances: [], totalUsd: 0 };
      throw new Error(`No provider registered for account type: ${account.type}`);
    },
  };
}

describe("syncAllUsers (cron sweep)", () => {
  it("sweeps every user and aggregates ok/failed account counts", async () => {
    const deps = makeDeps({
      u1: [manual("a1", "u1")],
      u2: [manual("a2", "u2"), badType("a3", "u2")], // a3 无 provider → failed
      u3: [], // 无账户
    });
    const res = await syncAllUsers(deps, ["u1", "u2", "u3"]);
    expect(res).toEqual({ users: 3, ok: 2, failed: 1, skipped: 0 });
  });

  it("isolates a user whose listAccounts throws — others still sync", async () => {
    const base = makeDeps({ u1: [manual("a1", "u1")], u2: [manual("a2", "u2")] });
    const deps: SyncDeps = {
      ...base,
      listAccounts: async (userId) => {
        if (userId === "u1") throw new Error("db blip");
        return base.listAccounts(userId);
      },
    };
    const res = await syncAllUsers(deps, ["u1", "u2"]);
    expect(res.users).toBe(2);
    expect(res.ok).toBe(1); // u2 仍成功
    expect(res.failed).toBe(1); // u1 抛错被隔离计为失败
  });

  it("handles an empty user list", async () => {
    const res = await syncAllUsers(makeDeps({}), []);
    expect(res).toEqual({ users: 0, ok: 0, failed: 0, skipped: 0 });
  });
});
