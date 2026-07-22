import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccountFor } from "../../src/lib/server/create-account";
import { db } from "../../src/lib/server/db";
import { createManualAccount, materializeManualCreds } from "../../src/lib/server/manual";

// manual 创建往返的真实 D1 集成测试(jsdom 单测覆盖不到的服务端编排)。
// 这套 pool 版本不隔离每测存储 → beforeEach 重置(删 user 级联清账户/token/活动)。
const USER = "user-manual-it";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run(); // cascade → accounts → manual_token/activity
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// 账户存储的 creds.tokens(provider 读的即此投影)。
async function credsTokens(accountId: string): Promise<unknown> {
  const raw = await db.getRawCreds(USER, accountId);
  const creds = JSON.parse(raw ?? "{}") as { tokens?: string };
  return JSON.parse(creds.tokens ?? "[]");
}

describe("createManualAccount (D1 round-trip)", () => {
  it("seeds token row + opening set activity + materialized creds.tokens", async () => {
    const tokens = JSON.stringify([
      { symbol: "BTC", unitPrice: "64000", identifier: "bitcoin", amount: "0.5" },
    ]);
    const account = await createManualAccount(USER, "My BTC", tokens);

    const rows = await db.listManualTokensByAccount(USER, account.id);
    expect(rows.map((r) => [r.symbol, r.unitPrice, r.identifier])).toEqual([
      ["BTC", 64000, "bitcoin"],
    ]);

    const acts = await db.listManualActivityByToken(USER, rows[0].id);
    expect(acts.map((a) => [a.kind, a.amount])).toEqual([["set", 0.5]]);

    expect(await credsTokens(account.id)).toEqual([
      { symbol: "BTC", unitPrice: 64000, amount: 0.5, identifier: "bitcoin" },
    ]);
  });

  it("rejects an empty tokens array (form always sends one; z.array admits [])", async () => {
    await expect(createManualAccount(USER, "M", "[]")).rejects.toThrow();
  });

  it("materializes creds.tokens the provider consumes (identifier omitted when absent)", async () => {
    // creds.tokens 即 provider 读取的投影(creds.tokens → N spot 由 provider golden 覆盖);此处验往返产出的形状。
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "ETH", unitPrice: "3200", amount: "2" }]),
    );
    expect(await credsTokens(account.id)).toEqual([{ symbol: "ETH", unitPrice: 3200, amount: 2 }]);
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

  it("valid manual input → account + token row + set activity + materialized creds", async () => {
    const account = await createAccountFor(USER, "manual", "My BTC", {
      tokens: JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", amount: "0.5", identifier: "bitcoin" },
      ]),
    });
    const rows = await db.listManualTokensByAccount(USER, account.id);
    expect(rows.map((r) => [r.symbol, r.unitPrice, r.identifier])).toEqual([
      ["BTC", 64000, "bitcoin"],
    ]);
    const acts = await db.listManualActivityByToken(USER, rows[0].id);
    expect(acts.map((a) => [a.kind, a.amount])).toEqual([["set", 0.5]]);
    expect(await credsTokens(account.id)).toEqual([
      { symbol: "BTC", unitPrice: 64000, amount: 0.5, identifier: "bitcoin" },
    ]);
  });
});

describe("materializeManualCreds (D1 round-trip)", () => {
  it("recomputes creds.tokens from the ledger after a later activity", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "60000", amount: "1" }]),
    );
    const [tokenRow] = await db.listManualTokensByAccount(USER, account.id);
    await db.recordManualActivity(USER, tokenRow.id, {
      kind: "add",
      amount: 0.5,
      occurredAt: Date.now() + 1,
    });
    await materializeManualCreds(USER, account.id);
    expect(await credsTokens(account.id)).toEqual([
      { symbol: "BTC", unitPrice: 60000, amount: 1.5 },
    ]);
  });
});
