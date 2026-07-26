import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveAmount } from "../../src/lib/manual-activity";
import { createAccountFor } from "../../src/lib/server/internal/create-account";
import { db } from "../../src/lib/server/internal/db";
import { createManualAccount } from "../../src/lib/server/internal/manual";
import { NAMER } from "../../src/lib/server/internal/oracle2";

// manual 创建往返的真实 D1 集成测试(jsdom 单测覆盖不到的服务端编排)。
// 这套 pool 版本不隔离每测存储 → beforeEach 重置(删 user 级联清账户/token/活动)。
const USER = "user-manual-it";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run(); // cascade → accounts/tokens → activity
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// 该账户的持仓(定义 + 账本折叠出的数量)。#203 起这是唯一事实源 —— 没有 creds.tokens 那个投影了。
async function holdings(accountId: string) {
  const rows = await db.listManualHoldingsByAccount(USER, accountId, NAMER);
  return Promise.all(
    rows.map(async (r) => ({
      symbol: r.symbol,
      unitPrice: r.unitPrice,
      identifier: r.identifier,
      amount: deriveAmount(await db.listManualActivityByToken(USER, accountId, r.id)),
    })),
  );
}

// 账户的 creds 里**不该**再有持仓数据(物化那一步删了)。
async function credsOf(accountId: string): Promise<Record<string, unknown>> {
  const raw = await db.getRawCreds(USER, accountId);
  return JSON.parse(raw ?? "{}");
}

describe("createManualAccount (D1 round-trip)", () => {
  it("认币 → 落声明 → 一条开仓 set 活动", async () => {
    const tokens = JSON.stringify([
      { symbol: "BTC", unitPrice: "64000", identifier: "bitcoin", amount: "0.5" },
    ]);
    const account = await createManualAccount(USER, "My BTC", tokens);

    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", unitPrice: 64000, identifier: "bitcoin", amount: 0.5 },
    ]);
  });

  // 用户选了币 → ref 是 `coingecko/bitcoin`,在 mint 里本身就是锚 → 直接认出来,不查映射表。
  it("选了币 → 那条 ref 就是 identifier 的来源", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "XBT", unitPrice: "1", amount: "1", identifier: "bitcoin" }]),
    );
    const [h] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    expect(h.identifier).toBe("bitcoin"); // 哪怕 symbol 敲成了 XBT
  });

  // creds 里那个 `tokens` 字段只剩一个空壳:它是**创建表单的入参声明**,不再是持仓的存储处。
  it("持仓数据不再写进 creds", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1" }]),
    );
    expect((await credsOf(account.id)).tokens).toBe("[]");
  });

  it("rejects an empty tokens array (form always sends one; z.array admits [])", async () => {
    await expect(createManualAccount(USER, "M", "[]")).rejects.toThrow();
  });

  it("没选币 → identifier 为空(上游没认出来),照样落库", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "PRIVATETOKEN", unitPrice: "3200", amount: "2" }]),
    );
    expect(await holdings(account.id)).toEqual([
      { symbol: "PRIVATETOKEN", unitPrice: 3200, identifier: null, amount: 2 },
    ]);
  });
});

// #1:createAccount handler 的分派逻辑(createAccountFor)—— manual 经**统一** validateAccountCreds 校验
// (provider 的 manualToken schema)+ 分派到账本创建。此前只直调 createManualAccount、绕过了这段。
describe("createAccountFor (manual: shared validate + dispatch)", () => {
  it("rejects manual creds missing symbol (runs through validateAccountCreds)", async () => {
    await expect(
      createAccountFor(USER, "manual", "M", {
        tokens: JSON.stringify([{ unitPrice: "1", amount: "1" }]),
      }),
    ).rejects.toThrow();
  });

  it("rejects when tokens is absent", async () => {
    await expect(createAccountFor(USER, "manual", "M", {})).rejects.toThrow();
  });

  it("合法入参 → 账户 + 持仓声明 + 开仓活动", async () => {
    const account = await createAccountFor(USER, "manual", "My BTC", {
      tokens: JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", amount: "0.5", identifier: "bitcoin" },
      ]),
    });
    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", unitPrice: 64000, identifier: "bitcoin", amount: 0.5 },
    ]);
  });
});

// #203:数量一律 compute-on-read。原来这里测的是「物化那一步把账本折叠写回 creds」——
// 那一步删了,于是「忘了重跑物化 → 显示 stale」这类 bug 面也整个消失。
describe("数量随账本即时变化(无物化)", () => {
  it("补一笔活动后,读出来的数量立刻是新的", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "60000", amount: "1" }]),
    );
    const [h] = await db.listManualHoldingsByAccount(USER, account.id, NAMER);
    await db.recordManualActivity(USER, account.id, h.id, {
      kind: "add",
      amount: 0.5,
      occurredAt: Date.now() + 1,
    });
    expect((await holdings(account.id))[0].amount).toBe(1.5);
  });
});
