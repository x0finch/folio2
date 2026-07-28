import { env } from "cloudflare:test";
import { formatTokenRef } from "@folio/oracle-ref";
import { tokenTicket } from "@folio/oracle2";
import { beforeEach, describe, expect, it } from "vitest";
import { type CredsToken, deriveAmount } from "../../src/lib/manual-activity";
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
import { NAMER } from "../../src/lib/server/internal/oracle2";

// T3(#155)服务端写路径集成:持仓 CRUD + 批量活动(原子)+ 删/改活动,全落库。真实 D1(Miniflare)。
// 不隔离每测存储 → beforeEach 重置。
// #203 起**没有物化那一步了** —— 断言直接读「持仓定义 + 账本折叠」(compute-on-read),
// 不再比对 creds.tokens 那个投影(它连同 manual provider 一起删了)。
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

// 选币下拉发给前端的那张票 = base64url 编过的 tokenRef。测试里现编,与生产同一个编码器 ——
// 手写 base64 字面量的话,编码规则一改测试就静默失配。
const ticketOf = (coinId: string) =>
  tokenTicket.encode(formatTokenRef({ namer: NAMER, localName: coinId }));

// 某 manual 账户已物化的 creds.tokens(投影)。
// 该账户的持仓:定义 + 账本折叠出的数量(compute-on-read;#203 之后没有 creds.tokens 那个投影了)。
async function readTokens(accountId: string): Promise<CredsToken[]> {
  const rows = await db.listManualHoldingsByAccount(USER, accountId, NAMER);
  return Promise.all(
    rows.map(async (r) => ({
      symbol: r.symbol,
      unitPrice: r.unitPrice,
      amount: deriveAmount(await db.listManualActivityByToken(USER, accountId, r.id)),
      ...(r.identifier ? { identifier: r.identifier } : {}),
    })),
  );
}

// 建一个仅一 token 的 manual 账户(BTC，初始 amount 1）。
async function seedAccount() {
  const account = await createManualAccount(
    USER,
    "M",
    JSON.stringify([
      { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
    ]),
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
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    await updateToken(USER, {
      accountId: account.id,
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 65000,
      amount: 3, // 从 1 → 3
    });
    const tokens = await readTokens(account.id);
    expect(tokens[0].unitPrice).toBe(65000);
    expect(tokens[0].amount).toBe(3);
    // 应追加了一条对齐 set(原开仓 set + 对齐 set = 2 条）。
    const activities = await db.listManualActivityByToken(USER, account.id, btc.id);
    expect(activities.filter((a) => a.kind === "set")).toHaveLength(2);
  });

  it("目标 amount 不变 → 不追加活动", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    await updateToken(USER, {
      accountId: account.id,
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 61000,
      amount: 1, // 不变
    });
    expect(await db.listManualActivityByToken(USER, account.id, btc.id)).toHaveLength(1);
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
    const eth = (await db.listManualHoldingsByAccount(USER, account.id, NAMER)).find(
      (t) => t.symbol === "ETH",
    );
    if (!eth) throw new Error("eth missing");
    await deleteToken(USER, account.id, eth.id);
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => t.symbol)).toEqual(["BTC"]);
  });
});

describe("addManualActivities", () => {
  it("对既有 token 加活动 → amount 折叠一致", async () => {
    const account = await seedAccount();
    const res = await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
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
        token: { symbol: "SOL", unitPrice: 150, ticket: ticketOf("solana") },
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
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 3,
      },
      {
        token: { symbol: "DOGE", unitPrice: 0.1, ticket: ticketOf("dogecoin") },
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
    expect(
      (await db.listManualHoldingsByAccount(USER, account.id, NAMER)).map((t) => t.symbol),
    ).toEqual(["BTC"]);
  });
});

describe("deleteManualActivity", () => {
  it("删活动 → amount 重新折叠", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
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
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    // 加一条 reduce 1(合法:1-1=0）。
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "reduce",
        amount: 1,
        occurredAt: LATER + 6,
      },
    ]);
    const reduce = (await db.listManualActivityByToken(USER, account.id, btc.id)).find(
      (a) => a.kind === "reduce",
    );
    if (!reduce) throw new Error("reduce missing");
    // 把 reduce 改成 5 → 超支。
    const res = await editManualActivity(USER, reduce.id, { amount: 5 });
    expect(res.ok).toBe(false);
    // 未写:活动仍是 1，amount 仍 0。
    const still = (await db.listManualActivityByToken(USER, account.id, btc.id)).find(
      (a) => a.id === reduce.id,
    );
    expect(still?.amount).toBe(1);
    expect((await readTokens(account.id))[0].amount).toBe(0);
  });

  it("合法改动 → 写入并重折叠", async () => {
    const account = await seedAccount();
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    const set = (await db.listManualActivityByToken(USER, account.id, btc.id))[0];
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

  it("跨用户改持仓 → 抛(token 归属校验)", async () => {
    await ensureOther();
    const account = await seedAccount(); // USER 拥有
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    await expect(
      updateToken(OTHER, {
        accountId: account.id,
        tokenId: btc.id,
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      }),
    ).rejects.toThrow();
  });

  it("跨用户清空持仓 → 抛", async () => {
    await ensureOther();
    const account = await seedAccount();
    const [btc] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    await expect(deleteToken(OTHER, account.id, btc.id)).rejects.toThrow();
  });

  it("跨用户往他人账户加活动 → 抛(commitManualBatch assertAccountOwned)", async () => {
    await ensureOther();
    const account = await seedAccount();
    await expect(
      addManualActivities(OTHER, account.id, [
        {
          token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
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

  // 闸口从「∈ 该账户既有 token」改成了「∈ 本人的 token」(#203)。前者现在会循环:
  // 账户与币的关系**由活动本身承载**,一条刚声明的持仓在活动插进去之前不属于任何账户。
  it("同一用户的两个手记账户可以持有同一个币(不再按账户设闸)", async () => {
    const a = await seedAccount(); // 有 BTC
    const b = await createManualAccount(
      USER,
      "B",
      JSON.stringify([{ symbol: "ETH", unitPrice: "1", amount: "1" }]),
    );
    const [btcTok] = await db.listManualHoldingsByAccount(USER, a.id, NAMER);

    await db.commitManualBatch(USER, {
      accountId: b.id,
      declare: [],
      activities: [{ tokenId: btcTok.id, kind: "add", amount: 1, occurredAt: LATER + 1 }],
    });

    // b 现在也持有它,数量各自独立(a 仍是 1)。
    expect((await readTokens(b.id)).find((t) => t.symbol === "BTC")?.amount).toBe(1);
    expect((await readTokens(a.id))[0].amount).toBe(1);
  });

  it("commitManualBatch 拒绝引用别人的 tokenId(纵深防御)", async () => {
    await ensureOther();
    const a = await seedAccount(); // USER 的
    const [btcTok] = await db.listManualHoldingsByAccount(USER, a.id, NAMER);
    const other = await createManualAccount(
      OTHER,
      "O",
      JSON.stringify([{ symbol: "ETH", unitPrice: "1", amount: "1" }]),
    );
    await expect(
      db.commitManualBatch(OTHER, {
        accountId: other.id,
        declare: [],
        activities: [{ tokenId: btcTok.id, kind: "add", amount: 1, occurredAt: LATER + 1 }],
      }),
    ).rejects.toThrow(/token not owned/);
  });
});
