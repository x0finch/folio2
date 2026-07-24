import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CredsToken } from "../../src/lib/manual-activity";
import { db } from "../../src/lib/server/internal/db";
import {
  addManualActivities,
  createManualAccount,
  createToken,
  deleteManualActivity,
  deleteToken,
  editManualActivity,
  updateToken,
} from "../../src/lib/server/internal/manual";

// T3(#155)服务端写路径集成:token CRUD + 批量活动(原子)+ 删/改活动,全落库、写后重跑物化。真实 D1(Miniflare)。
// 不隔离每测存储 → beforeEach 重置。断言以 creds.tokens(物化投影)与账本一致为准(单写者不变量)。
const USER = "user-manual-t3";
// seedAccount 的开仓 set 活动 occurredAt = Date.now()(≈1.7e12);后续活动须发生在其**之后**,
// 否则 set 会重置基线覆盖它们。用一段远未来的时间戳(仍是合法 epoch-ms)确保排序在 set 之后。
const LATER = 4_000_000_000_000;

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// 某 manual 账户已物化的 creds.tokens(投影)。
async function readTokens(accountId: string): Promise<CredsToken[]> {
  const raw = await db.getRawCreds(USER, accountId);
  if (!raw) return [];
  const creds = JSON.parse(raw) as { tokens?: string };
  return creds.tokens ? (JSON.parse(creds.tokens) as CredsToken[]) : [];
}

// 建一个仅一 token 的 manual 账户(BTC，初始 amount 1）。
async function seedAccount() {
  const account = await createManualAccount(
    USER,
    "M",
    JSON.stringify([{ symbol: "BTC", unitPrice: "60000", identifier: "bitcoin", amount: "1" }]),
  );
  return account;
}

describe("createToken", () => {
  it("建 token + 开仓 set 活动 → creds.tokens 出现该 token,amount === 初始", async () => {
    const account = await seedAccount();
    await createToken(USER, {
      accountId: account.id,
      symbol: "ETH",
      unitPrice: 3000,
      identifier: "ethereum",
      amount: 2,
    });
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => [t.symbol, t.amount]).sort()).toEqual([
      ["BTC", 1],
      ["ETH", 2],
    ]);
    expect(tokens.find((t) => t.symbol === "ETH")?.identifier).toBe("ethereum");
  });
});

describe("updateToken", () => {
  it("改单价/标识即时反映;改目标 amount → 追加 set 对齐,derived === 新值", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    await updateToken(USER, {
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 65000,
      identifier: "bitcoin",
      amount: 3, // 从 1 → 3
    });
    const tokens = await readTokens(account.id);
    expect(tokens[0].unitPrice).toBe(65000);
    expect(tokens[0].amount).toBe(3);
    // 应追加了一条对齐 set(原开仓 set + 对齐 set = 2 条）。
    const activities = await db.listManualActivityByToken(USER, btc.id);
    expect(activities.filter((a) => a.kind === "set")).toHaveLength(2);
  });

  it("目标 amount 不变 → 不追加活动", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    await updateToken(USER, {
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 61000,
      identifier: "bitcoin",
      amount: 1, // 不变
    });
    expect(await db.listManualActivityByToken(USER, btc.id)).toHaveLength(1);
  });
});

describe("deleteToken", () => {
  it("删 token → 从 creds.tokens 消失(活动级联清)", async () => {
    const account = await seedAccount();
    await createToken(USER, {
      accountId: account.id,
      symbol: "ETH",
      unitPrice: 3000,
      amount: 2,
    });
    const eth = (await db.listManualTokensByAccount(USER, account.id)).find(
      (t) => t.symbol === "ETH",
    );
    if (!eth) throw new Error("eth missing");
    await deleteToken(USER, eth.id);
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => t.symbol)).toEqual(["BTC"]);
  });
});

describe("addManualActivities", () => {
  it("对既有 token 加活动 → amount 折叠一致", async () => {
    const account = await seedAccount();
    const res = await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
      },
    ]);
    expect(res.ok).toBe(true);
    const tokens = await readTokens(account.id);
    expect(tokens[0].amount).toBe(1.5); // 1 + 0.5
  });

  it("草稿指向未持有 token → 现建持仓 + 记活动(原子)", async () => {
    const account = await seedAccount();
    const res = await addManualActivities(USER, account.id, [
      {
        token: { symbol: "SOL", unitPrice: 150, identifier: "solana" },
        kind: "add",
        amount: 10,
        occurredAt: LATER + 2,
      },
    ]);
    expect(res.ok).toBe(true);
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => t.symbol).sort()).toEqual(["BTC", "SOL"]);
    expect(tokens.find((t) => t.symbol === "SOL")?.amount).toBe(10);
  });

  it("整批拒:任一 reduce 在其时点超支 → {ok:false},且什么都不写(原子)", async () => {
    const account = await seedAccount();
    const before = await readTokens(account.id);
    const res = await addManualActivities(USER, account.id, [
      // 既有 BTC 持有 1;这批同时对既有加 0.5(合法)+ 对新 token DOGE reduce 100(基线 0，超支)。
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 3,
      },
      {
        token: { symbol: "DOGE", unitPrice: 0.1, identifier: "dogecoin" },
        kind: "reduce",
        amount: 100,
        occurredAt: LATER + 3,
      },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.symbol).toBe("DOGE");
    // 原子:BTC 未变、DOGE 未建。
    expect(await readTokens(account.id)).toEqual(before);
    expect((await db.listManualTokensByAccount(USER, account.id)).map((t) => t.symbol)).toEqual([
      "BTC",
    ]);
  });
});

describe("deleteManualActivity", () => {
  it("删活动 → amount 重新折叠", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 2,
        occurredAt: LATER + 5,
      },
    ]);
    expect((await readTokens(account.id))[0].amount).toBe(3); // 1 + 2
    const added = (await db.listManualActivityByAccount(USER, account.id)).find(
      (a) => a.kind === "add",
    );
    if (!added) throw new Error("add activity missing");
    await deleteManualActivity(USER, account.id, added.id);
    expect((await readTokens(account.id))[0].amount).toBe(1); // 删掉 add 后回到 1
  });
});

describe("editManualActivity", () => {
  it("改活动致超支 → {ok:false},不写", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    // 加一条 reduce 1(合法:1-1=0）。
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "reduce",
        amount: 1,
        occurredAt: LATER + 6,
      },
    ]);
    const reduce = (await db.listManualActivityByToken(USER, btc.id)).find(
      (a) => a.kind === "reduce",
    );
    if (!reduce) throw new Error("reduce missing");
    // 把 reduce 改成 5 → 超支。
    const res = await editManualActivity(USER, reduce.id, { amount: 5 });
    expect(res.ok).toBe(false);
    // 未写:活动仍是 1，amount 仍 0。
    const still = (await db.listManualActivityByToken(USER, btc.id)).find(
      (a) => a.id === reduce.id,
    );
    expect(still?.amount).toBe(1);
    expect((await readTokens(account.id))[0].amount).toBe(0);
  });

  it("合法改动 → 写入并重折叠", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    const set = (await db.listManualActivityByToken(USER, btc.id))[0];
    const res = await editManualActivity(USER, set.id, { amount: 4 });
    expect(res.ok).toBe(true);
    expect((await readTokens(account.id))[0].amount).toBe(4);
  });

  it("空 patch → 不抛(drizzle 空 set 会抛),幂等 {ok:true}", async () => {
    const account = await seedAccount();
    const set = (await db.listManualActivityByAccount(USER, account.id))[0];
    const res = await editManualActivity(USER, set.id, {});
    expect(res.ok).toBe(true);
    expect((await readTokens(account.id))[0].amount).toBe(1);
  });
});

// 越权负路径:验 T3 新增 db ops 的归属守卫(userId-scoped assert + commitManualBatch 的 tokenId∈账户 校验)。
// 每条守卫失败即抛,从 API 形状上杜绝跨用户/跨账户写。
describe("越权防御(跨用户 / 跨账户)", () => {
  const OTHER = "user-manual-t3-other";
  async function ensureOther(): Promise<void> {
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(OTHER).run();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(OTHER, OTHER, `${OTHER}@example.com`, 0, now, now)
      .run();
  }

  it("跨用户改 token → 抛(getManualTokenAccountId 归属校验)", async () => {
    await ensureOther();
    const account = await seedAccount(); // USER 拥有
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    await expect(
      updateToken(OTHER, { tokenId: btc.id, symbol: "BTC", unitPrice: 1, amount: 1 }),
    ).rejects.toThrow();
  });

  it("跨用户删 token → 抛", async () => {
    await ensureOther();
    const account = await seedAccount();
    const [btc] = await db.listManualTokensByAccount(USER, account.id);
    await expect(deleteToken(OTHER, btc.id)).rejects.toThrow();
  });

  it("跨用户往他人账户加活动 → 抛(commitManualBatch assertAccountOwned)", async () => {
    await ensureOther();
    const account = await seedAccount();
    await expect(
      addManualActivities(OTHER, account.id, [
        {
          token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
          kind: "add",
          amount: 1,
          occurredAt: LATER + 1,
        },
      ]),
    ).rejects.toThrow();
    // 未写:USER 的 BTC 仍是 1(OTHER 的操作被挡在 assert,零副作用)。
    expect((await readTokens(account.id))[0].amount).toBe(1);
  });

  it("跨用户编辑他人活动 → 抛(getManualActivityOwner)", async () => {
    await ensureOther();
    const account = await seedAccount();
    const set = (await db.listManualActivityByAccount(USER, account.id))[0];
    await expect(editManualActivity(OTHER, set.id, { amount: 2 })).rejects.toThrow();
  });

  it("commitManualBatch 拒绝引用非本账户的 tokenId(纵深防御)", async () => {
    const a = await seedAccount(); // 有 BTC token
    const b = await createManualAccount(
      USER,
      "B",
      JSON.stringify([{ symbol: "ETH", unitPrice: "1", amount: "1" }]),
    );
    const [btcTok] = await db.listManualTokensByAccount(USER, a.id);
    // 往账户 b 提交一条引用账户 a 的 token 的活动 → 被 allowed-set 校验拒。
    await expect(
      db.commitManualBatch(USER, {
        accountId: b.id,
        newTokens: [],
        activities: [{ tokenId: btcTok.id, kind: "add", amount: 1, occurredAt: LATER + 1 }],
      }),
    ).rejects.toThrow(/token not in account/);
  });
});
