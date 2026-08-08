import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import {
  AccountStore,
  accountStoreLayer,
  importAccount,
  importManualActivity,
  importSnapshot,
  importToken,
  listTokensForExport,
  ManualStore,
  manualStoreLayer,
  SnapshotStore,
  snapshotStoreLayer,
} from "../src/queries";
import { tokenRefs, tokens } from "../src/schema";
import { user } from "../src/schema/auth";
import { forUser } from "./effect";

const manualOf = forUser(ManualStore, manualStoreLayer);
const snapshotsOf = forUser(SnapshotStore, snapshotStoreLayer);

const accounts = forUser(AccountStore, accountStoreLayer);

// 导出/导入 v3 的 db 支持(#204):listTokensForExport(带 ref)、listManualActivityByUser(扁平跨账户),
// 以及 A 方案的 find-or-create 一族(importToken/importAccount/importSnapshot/
// importManualActivity)—— 各按内容自然键去重,让反复导入/合并幂等。对着真 D1 跑(约束/唯一索引真生效)。

const USER_A = "u-a";
const USER_B = "u-b";
const USDC_CGK = { namer: "coingecko", localName: "issued:usd-coin" };
const USDC_ETH = { namer: "evm:1", localName: "contract:0xa0b8" };
const BTC_CGK = { namer: "coingecko", localName: "issued:bitcoin" };

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

const refKey = (r: { namer: string; localName: string }) => `${r.namer}/${r.localName}`;

describe("listTokensForExport", () => {
  it("导出 Token,ref 嵌在里头;空用户 → []", async () => {
    expect(await listTokensForExport(env, USER_A)).toEqual([]);
    const id = await importToken(
      env,
      USER_A,
      { symbol: "USDC", name: "USD Coin", logo: "u.png", providerLogo: "p.png", marketCapRank: 7 },
      [USDC_CGK, USDC_ETH],
    );
    const out = await listTokensForExport(env, USER_A);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id,
      symbol: "USDC",
      name: "USD Coin",
      logo: "u.png",
      providerLogo: "p.png",
      marketCapRank: 7,
    });
    expect(new Set(out[0]!.refs.map(refKey))).toEqual(
      new Set([refKey(USDC_CGK), refKey(USDC_ETH)]),
    );
  });

  it("按用户隔离", async () => {
    await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    expect(await listTokensForExport(env, USER_B)).toEqual([]);
  });
});

describe("importToken —— find-or-create", () => {
  it("空库 → 新建一行,返回新 id", async () => {
    const id = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    expect(id).toBeTruthy();
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe("USDC");
  });

  it("ref 已存在 → 复用那行,不新建(空库重映射的对面情形)", async () => {
    const id1 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    const id2 = await importToken(env, USER_A, { symbol: "USDCdup", name: "dup" }, [USDC_CGK]);
    expect(id2).toBe(id1);
    expect(await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A))).toHaveLength(1);
  });

  it("复用时把缺的 ref 补挂到已有 Token", async () => {
    const id1 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    const id2 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
      USDC_ETH,
    ]);
    expect(id2).toBe(id1);
    const refs = await getDb(env).select().from(tokenRefs).where(eq(tokenRefs.tokenId, id1));
    expect(new Set(refs.map(refKey))).toEqual(new Set([refKey(USDC_CGK), refKey(USDC_ETH)]));
  });

  it("无 ref 的 Token(理论边界)→ 照样建行", async () => {
    const id = await importToken(env, USER_A, { symbol: "FOO", name: "Foo" }, []);
    expect((await getDb(env).select().from(tokens).where(eq(tokens.id, id)))[0]!.symbol).toBe(
      "FOO",
    );
  });
});

describe("importAccount —— find-or-create(自然键 = connectorId+platform+label+creds)", () => {
  it("同内容再导 → 复用,不新建;created 标志正确", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    const a = await importAccount(env, USER_A, input);
    const b = await importAccount(env, USER_A, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(await accounts(USER_A).list()).toHaveLength(1);
  });

  it("任一自然键字段不同 → 视为新账户", async () => {
    const base = { connectorId: "evm" as const, platform: "evm:1", label: "W" };
    await importAccount(env, USER_A, { ...base, creds: JSON.stringify({ address: "0x1" }) });
    await importAccount(env, USER_A, { ...base, creds: JSON.stringify({ address: "0x2" }) }); // creds 不同
    await importAccount(env, USER_A, {
      ...base,
      label: "W2",
      creds: JSON.stringify({ address: "0x1" }),
    }); // label 不同
    expect(await accounts(USER_A).list()).toHaveLength(3);
  });

  it("命中既有、文件说归档而现有未归档 → 对齐成归档", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    await importAccount(env, USER_A, input);
    await importAccount(env, USER_A, { ...input, archivedAt: 1700000000000 });
    const acc = (await accounts(USER_A).list())[0]!;
    expect(acc.archivedAt).toBe(1700000000000);
  });

  it("按用户隔离:同内容不同用户各建各的", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    await importAccount(env, USER_A, input);
    const b = await importAccount(env, USER_B, input);
    expect(b.created).toBe(true);
    expect(await accounts(USER_A).list()).toHaveLength(1);
    expect(await accounts(USER_B).list()).toHaveLength(1);
  });
});

describe("importSnapshot —— find-or-create(自然键 = account+takenAt)", () => {
  it("同 (账户,takenAt) 再导 → 整份跳过,不重复写", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "evm",
      label: "W",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const snap = {
      takenAt: 1000,
      totalUsd: 100,
      balances: [{ tokenId: tk, amount: 1, usdValue: 100, kind: "spot" as const }],
    };
    const a = await importSnapshot(env, USER_A, acc.id, snap);
    const b = await importSnapshot(env, USER_A, acc.id, snap);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await snapshotsOf(USER_A).listByAccount(acc.id)).toHaveLength(1);
    // 不同 takenAt → 新快照
    await importSnapshot(env, USER_A, acc.id, { ...snap, takenAt: 2000 });
    expect(await snapshotsOf(USER_A).listByAccount(acc.id)).toHaveLength(2);
  });
});

describe("importManualActivity —— find-or-create(自然键 = 整条内容)", () => {
  it("同内容再导 → 跳过(不折叠翻倍);任一字段不同 → 新增", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const act = { kind: "add" as const, amount: 1, price: 60000, occurredAt: 1000, createdAt: 5 };
    const a = await importManualActivity(env, USER_A, acc.id, tk, act);
    const b = await importManualActivity(env, USER_A, acc.id, tk, act);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(1);
    // amount 不同 → 新增一条
    await importManualActivity(env, USER_A, acc.id, tk, { ...act, amount: 2 });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });

  it("price/fee/memo 的 null 与有值区分正确(isNull 分支)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const base = { kind: "add" as const, amount: 1, occurredAt: 1000 };
    await importManualActivity(env, USER_A, acc.id, tk, base); // price/fee/memo 全 null
    const dup = await importManualActivity(env, USER_A, acc.id, tk, base);
    expect(dup.created).toBe(false); // null 内容也能命中
    const withPrice = await importManualActivity(env, USER_A, acc.id, tk, { ...base, price: 1 });
    expect(withPrice.created).toBe(true); // null vs 有值 → 不同
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });

  it("两笔除 createdAt 外全同 → 是不同事件,都保留(createdAt 进键,防折叠丢量)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const base = { kind: "add" as const, amount: 1, price: 60000, occurredAt: 1000 };
    const a = await importManualActivity(env, USER_A, acc.id, tk, { ...base, createdAt: 5 });
    const b = await importManualActivity(env, USER_A, acc.id, tk, { ...base, createdAt: 9 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // createdAt 不同 → 不折叠
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
    // 再导同两条 → 都命中、不新增(幂等)。
    await importManualActivity(env, USER_A, acc.id, tk, { ...base, createdAt: 5 });
    await importManualActivity(env, USER_A, acc.id, tk, { ...base, createdAt: 9 });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });
});

describe("listManualActivityByUser", () => {
  it("跨账户扁平返回、按 occurred→created 升序、createdAt 保留、按用户隔离", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    await manualOf(USER_A).recordActivity(acc.id, tk, {
      kind: "add",
      amount: 1,
      price: 60000,
      occurredAt: 1000,
      createdAt: 5,
    });
    await manualOf(USER_A).recordActivity(acc.id, tk, {
      kind: "add",
      amount: 2,
      price: 61000,
      occurredAt: 2000,
      createdAt: 6,
    });

    const out = await manualOf(USER_A).listAllActivity();
    expect(out.map((a) => a.amount)).toEqual([1, 2]); // 升序
    expect(out[0]).toMatchObject({ accountId: acc.id, tokenId: tk, createdAt: 5 }); // createdAt 保留
    expect(await manualOf(USER_B).listAllActivity()).toEqual([]);
  });
});
