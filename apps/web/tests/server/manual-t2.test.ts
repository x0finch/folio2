import { env } from "cloudflare:test";
import type { SnapshotWithBalances } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/server/internal/db";
import {
  createManualAccount,
  injectManualSnapshots,
  manualBalancesForWarm,
} from "../../src/lib/server/internal/manual";
import { ticketOf } from "./ticket";

// T2(ADR 0018)服务端集成:manual 退出 snapshot、当下值由 creds 现造。真实 D1(Miniflare)。
// 不隔离每测存储 → beforeEach 重置。
const USER = "user-manual-t2";

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

async function snapshotCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
async function balanceCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM snapshot_balances WHERE snapshot_id IN (SELECT id FROM snapshots WHERE account_id = ?)",
  )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// 直接写一行快照 + 一条余额(绕过 sync,单测 purge 谓词用)。
async function seedSnapshot(accountId: string): Promise<void> {
  await db.writeSnapshot(USER, accountId, {
    takenAt: Date.now(),
    totalUsd: 100,
    balances: [{ symbol: "BTC", amount: 1, usdValue: 100, kind: "spot" }],
  });
}

describe("injectManualSnapshots (D1 round-trip)", () => {
  it("为 manual 账户注入合成当下项(cache 冷 → 回退 unitPrice)", async () => {
    const account = await createManualAccount(
      USER,
      "My BTC",
      JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", ticket: ticketOf("bitcoin"), amount: "0.5" },
      ]),
    );
    const accounts = await db.listAccountsByUser(USER);
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    expect(synth).toBeDefined();
    expect(synth?.balances.map((b) => [b.symbol, b.amount])).toEqual([["BTC", 0.5]]);
    // 测试环境 token 缓存空 → enrich 无价 → 回退 amount × unitPrice = 0.5 × 64000。
    expect(synth?.snapshot.totalUsd).toBe(32000);
    expect(synth?.balances[0].selfPrice).toBeNull();
    expect(synth?.balances[0].tokenRef).toBe("coingecko/issued:bitcoin");
  });

  // 给已 mint 的 per-user token(coingecko ref = `issued:<coinId>`)灌一个市价 —— 模拟同步的
  // warmHeldPrices / 前端 refreshStalePrices 之后、缓存里有价的状态。新参考层价 facet 就在
  // 该用户 `tokens` 行上(#199),读路径 enrich 从这里取(cache-only,零网络)。
  async function warmUserPrice(coinId: string, unitPrice: number): Promise<void> {
    const row = await env.DB.prepare(
      "SELECT token_id FROM token_refs WHERE user_id = ? AND namer = 'coingecko' AND local_name = ?",
    )
      .bind(USER, `issued:${coinId}`)
      .first<{ token_id: string }>();
    if (!row) throw new Error(`no minted token for coingecko/issued:${coinId}`);
    await env.DB.prepare(
      "UPDATE tokens SET unit_price = ?, price_as_of = ?, price_expires_at = ? WHERE user_id = ? AND id = ?",
    )
      .bind(unitPrice, 1, 4_000_000_000_000, USER, row.token_id)
      .run();
  }

  // **#223 / #227:手敲的 symbol 不许拿别人的价。**
  // 没选币的手记币其 token 行 `ref` 为空、从不链 CGK —— enrich 按 token_id 只看它自己那行,
  // 结构上就够不到任何真币的价(哪怕同用户库里另有一个有市价的真 USDC)。故自填价恒赢。
  it("没选币 → 用他填的单价,哪怕库里另有个有市价的真 USDC", async () => {
    // 同用户库里先摆一个真 USDC(选了币 + 有市价)——证明隔离靠的是 token_id,不是没币可拿。
    await createManualAccount(
      USER,
      "Picked USDC",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "1", amount: "1", ticket: ticketOf("usd-coin") },
      ]),
    );
    await warmUserPrice("usd-coin", 1);
    const account = await createManualAccount(
      USER,
      "My USDC",
      JSON.stringify([{ symbol: "USDC", unitPrice: "777", amount: "10" }]),
    );
    const accounts = await db.listAccountsByUser(USER);
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    expect(synth?.balances[0].tokenRef).toBe("manual/custom:USDC");
    expect(synth?.snapshot.totalUsd).toBe(7770); // 10 × 777,不是 10 × 1
  });

  // 对照:选了币、缓存里有价就该拿市价 —— 否则上面那条用「一律不问价」也能绿,等于没测。
  it("选了币 + 缓存有价 → 拿市价,不是他填的单价", async () => {
    const account = await createManualAccount(
      USER,
      "Picked USDC",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "777", amount: "10", ticket: ticketOf("usd-coin") },
      ]),
    );
    await warmUserPrice("usd-coin", 1); // mint 之后灌价(新层价 facet 在 per-user token 行上)
    const accounts = await db.listAccountsByUser(USER);
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    expect(synth?.balances[0].tokenRef).toBe("coingecko/issued:usd-coin");
    expect(synth?.snapshot.totalUsd).toBe(10); // 10 × 1
  });

  it("非 manual 账户不注入", async () => {
    const btc = await db.createAccount(USER, {
      connectorId: "bitcoin",
      label: "BTC wallet",
      creds: null,
    });
    const accounts = await db.listAccountsByUser(USER);
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount);
    expect(byAccount.has(btc.id)).toBe(false);
  });
});

// 预热/刷价共用的合成余额收集器(warmTokensForUser 与 refreshStalePrices 同门,与 injector enrich 门同源)。
describe("manualBalancesForWarm", () => {
  it("返回活跃 manual 账户的合成余额,排除归档", async () => {
    await createManualAccount(
      USER,
      "Active",
      JSON.stringify([
        { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
      ]),
    );
    const archived = await createManualAccount(
      USER,
      "Archived",
      JSON.stringify([
        { symbol: "ETH", unitPrice: "3000", ticket: ticketOf("ethereum"), amount: "2" },
      ]),
    );
    await db.setArchived(USER, archived.id, true);

    const accounts = await db.listAccountsByUser(USER); // 含归档
    const balances = await manualBalancesForWarm(USER, accounts);
    // 只应含活跃账户的币(BTC),不含归档账户的币(ETH)。
    expect(balances.map((b) => b.symbol)).toEqual(["BTC"]);
    expect(balances.every((b) => b.tokenRef === "coingecko/issued:bitcoin")).toBe(true);
  });
});

describe("purge 迁移谓词:删 manual 快照,留其余(级联删余额)", () => {
  it("DELETE ... WHERE account_id IN (manual accounts) 只删 manual", async () => {
    const manual = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "ETH", unitPrice: "3000", amount: "1" }]),
    );
    const btc = await db.createAccount(USER, {
      connectorId: "bitcoin",
      label: "BTC wallet",
      creds: null,
    });
    // manual 账户本不该有快照,但历史遗留行正是本迁移要清的 → 手动种一行模拟。
    await seedSnapshot(manual.id);
    await seedSnapshot(btc.id);
    expect(await snapshotCount(manual.id)).toBe(1);
    expect(await balanceCount(manual.id)).toBe(1);

    await env.DB.prepare(
      "DELETE FROM snapshots WHERE account_id IN (SELECT id FROM accounts WHERE connector_id = 'manual')",
    ).run();

    expect(await snapshotCount(manual.id)).toBe(0);
    expect(await balanceCount(manual.id)).toBe(0); // ON DELETE cascade
    expect(await snapshotCount(btc.id)).toBe(1); // 非 manual 保留
  });
});
