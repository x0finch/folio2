import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
// 测试可用包内私有句柄:userId→user 外键已启用,业务行需先有 user 行。
import { user } from "../src/schema/auth";
import { forDomain, forGlobal } from "./effect"; // 包内测试白盒:公开面只出 createDb 门面(见 encapsulation.test)

const snapshotsOf = forDomain((db) => db.snapshots);

const accounts = forDomain((db) => db.accounts);
// cron 那条:没有 userId,所以它在 `GlobalDatabase` 上。
const globalAccounts = forGlobal((db) => db.accounts);
const settings = forDomain((db) => db.settings);

const USER_A = "user-a";
const USER_B = "user-b";

// pool-workers 此版本不隔离每个测试的存储。每个测试前重置:删 user 行(级联清掉其
// accounts/portfolios/snapshots/...),再插入干净的 user 行(满足业务表的 userId 外键)。
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

describe("accounts", () => {
  it("creates, lists, gets, and deletes an account (safe shape, no ciphertext)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "Cash",
      creds: "cipher",
    });
    expect(acc.id).toBeTruthy();
    expect(Object.keys(acc)).not.toContain("encCredentials");

    const list = await accounts(USER_A).list();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Cash");

    const got = await accounts(USER_A).getById(acc.id);
    expect(got?.connectorId).toBe("manual");
    expect(Object.keys(got!)).not.toContain("encCredentials");

    await accounts(USER_A).remove(acc.id);
    expect(await accounts(USER_A).list()).toHaveLength(0);
  });

  it("returns the opaque creds map only via the internal getter", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "Binance",
      creds: '{"apiKey":"K","secret":"<enc>"}',
    });
    expect(await accounts(USER_A).getRawCreds(acc.id)).toBe('{"apiKey":"K","secret":"<enc>"}');
  });

  it("listUserIds returns distinct user ids that own accounts (cron sweep)", async () => {
    expect(await globalAccounts().listUserIds()).toEqual([]); // 无账户
    await accounts(USER_A).create({ connectorId: "manual", label: "A1", creds: "x" });
    await accounts(USER_A).create({ connectorId: "manual", label: "A2", creds: "x" }); // 同用户两账户 → 去重
    await accounts(USER_B).create({ connectorId: "manual", label: "B1", creds: "x" });
    const ids = await globalAccounts().listUserIds();
    expect([...ids].sort()).toEqual([USER_A, USER_B].sort());
  });

  it("round-trips the creds map (incl. semi_ placeholder) and rehydrates via setAccountCredentials", async () => {
    // 导入的缺凭据 CEX:creds 只含 semi 打码占位(无真 apiKey/secret)。
    const imported = JSON.stringify({ semi_apiKey: "ABCD…5678" });
    const acc = await accounts(USER_A).create({
      connectorId: "okx",
      label: "Imported OKX",
      creds: imported,
    });
    expect(await accounts(USER_A).getRawCreds(acc.id)).toBe(imported);
    // creds 不进安全形状(含 secret 密文)。
    const got = await accounts(USER_A).getById(acc.id);
    expect(Object.keys(got!)).not.toContain("creds");

    // 补录:整张 map 覆盖。
    const sealed = JSON.stringify({ apiKey: "REAL", secret: "<enc>", passphrase: "<enc>" });
    await accounts(USER_A).setCredentials(acc.id, sealed);
    expect(await accounts(USER_A).getRawCreds(acc.id)).toBe(sealed);
  });

  it("renameAccount changes the label (user-scoped)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "Old",
      creds: "x",
    });
    await accounts(USER_A).rename(acc.id, "New");
    expect((await accounts(USER_A).getById(acc.id))?.label).toBe("New");
    // 越权:另一用户改不动。
    await accounts(USER_B).rename(acc.id, "Hacked");
    expect((await accounts(USER_A).getById(acc.id))?.label).toBe("New");
  });

  it("setArchived toggles archivedAt (reversible, user-scoped)", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "manual", label: "M", creds: "x" });
    expect((await accounts(USER_A).getById(acc.id))?.archivedAt).toBeNull();
    await accounts(USER_A).setArchived(acc.id, true);
    expect((await accounts(USER_A).getById(acc.id))?.archivedAt).toBeGreaterThan(0);
    await accounts(USER_A).setArchived(acc.id, false);
    expect((await accounts(USER_A).getById(acc.id))?.archivedAt).toBeNull();
  });

  it("listRawCredsByUser returns each account's raw creds (user-scoped; for safeView 富化)", async () => {
    const a1 = await accounts(USER_A).create({ connectorId: "manual", label: "M", creds: "{}" });
    const a2 = await accounts(USER_A).create({
      connectorId: "evm",
      label: "W",
      creds: '{"identifier":"0xabc"}',
    });
    await accounts(USER_B).create({ connectorId: "manual", label: "B", creds: "{}" });
    const rows = await accounts(USER_A).listRawCreds();
    expect(new Map(rows.map((r) => [r.id, r.creds]))).toEqual(
      new Map([
        [a1.id, "{}"],
        [a2.id, '{"identifier":"0xabc"}'],
      ]),
    );
  });
});

describe("snapshots", () => {
  it("writes snapshot + balances atomically and reads them back", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const id = await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1000,
      totalUsd: 150,
      // symbol 不再落快照(#243);行按 token_id 区分。
      balances: [
        {
          tokenId: "tk-btc",
          amount: 0.001,
          usdValue: 100,
          kind: "spot",
          platform: "binance",
          selfPrice: 100000,
        },
        {
          tokenId: "tk-eth",
          amount: 0.02,
          usdValue: 50,
          kind: "spot",
          platform: "binance",
          meta: { note: "x" },
        },
      ],
    });
    expect(id).toBeTruthy();

    const snaps = await snapshotsOf(USER_A).listByAccount(acc.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.totalUsd).toBe(150);

    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(1);
    expect(latest[0]!.balances).toHaveLength(2);
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-eth")!.metaJson).toContain("note");
    // 无 note 写入 → 各行 note 省略。
    expect(latest[0]!.balances.every((b) => b.note === undefined)).toBe(true);
    // self_price 落库/读回(估值原料,Phase 3):BTC 行有、ETH 行无(null)。
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-btc")!.selfPrice).toBe(100000);
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-eth")!.selfPrice).toBeNull();
  });

  // 24h 盈亏的「起点」端(ADR 0050):每账户 `[floor, t]` 窗口内**最近**一张 + 其余额。
  //   · **≤ t,不是 ≥ t**:往后找最近一张等于拿几小时前的数冒充 24 小时前;
  //   · `floor`(7 天断线线):窗口内一张都没有的账户不出现(该账户起点空 → 涨跌当 0)。
  it("asOf:取 [floor, t] 窗口内最近一张 —— 更晚的不顶上、窗口外的不出现", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "binance", label: "B", creds: "x" });
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ amount: 1, usdValue: 10, kind: "spot", tokenId: "tk-btc" }],
    });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 2000, totalUsd: 20, balances: [] });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 3000, totalUsd: 30, balances: [] });

    // t=2500, floor=0 → ≤ 2500 里最近那张是 2000(3000 不许顶上来)。
    const at2500 = await snapshotsOf(USER_A).asOf(2500, 0);
    expect(at2500).toHaveLength(1);
    expect(at2500[0]!.snapshot.takenAt).toBe(2000);

    // 等于 t 的算数(≤)。
    expect((await snapshotsOf(USER_A).asOf(1000, 0))[0]!.snapshot.takenAt).toBe(1000);
    expect((await snapshotsOf(USER_A).asOf(1000, 0))[0]!.balances).toHaveLength(1);

    // floor 把窗口下界卡住:t=2500 但 floor=2100 → 窗口 [2100,2500] 内一张都没有 → 不出现。
    expect(await snapshotsOf(USER_A).asOf(2500, 2100)).toEqual([]);
    // 比最早那张还早 → 空。
    expect(await snapshotsOf(USER_A).asOf(500, 0)).toEqual([]);
  });

  // 单账户曲线的数据源(FOL-38):两列 + `since` 窗口。窗口是这条读接口的**上界** ——
  // 它发的是原样的点,不裁的话「攒了多久就发多大」。
  it("listTotalsByAccount:按 since 裁窗口,升序,只给 (takenAt, totalUsd)", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "binance", label: "B", creds: "x" });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 300, totalUsd: 30, balances: [] });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 100, totalUsd: 10, balances: [] });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 200, totalUsd: 20, balances: [] });

    const all = await snapshotsOf(USER_A).listTotalsByAccount(acc.id);
    expect(all).toEqual([
      { takenAt: 100, totalUsd: 10 },
      { takenAt: 200, totalUsd: 20 },
      { takenAt: 300, totalUsd: 30 },
    ]);
    // 窗口在 SQL 里,不是查回来再过滤 —— 窗口外那行不出库。
    expect(await snapshotsOf(USER_A).listTotalsByAccount(acc.id, 200)).toEqual([
      { takenAt: 200, totalUsd: 20 },
      { takenAt: 300, totalUsd: 30 },
    ]);
    expect(await snapshotsOf(USER_A).listTotalsByAccount(acc.id, 999)).toEqual([]);
  });

  it("persists per-balance note (single Note) + account-level note (Note[]) and safeParses back (note 重设计)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "bitcoin",
      label: "BTC",
      creds: "x",
    });
    // balance 级:单个 Note(CEX 锁仓口径示例)。
    const note = {
      title: "Locked",
      icon: "warning" as const,
      content: [{ label: "BTC", value: 0.005, unit: "BTC" }],
    };
    // account 级:Note[](整钱包)。
    const accountNote = [
      {
        title: "Unconfirmed",
        icon: "warning" as const,
        content: [{ label: "Pending", value: 0.005, unit: "BTC" }],
      },
      { title: "Note", content: "all available" },
    ];
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1000,
      totalUsd: 0,
      note: accountNote,
      balances: [
        { tokenId: "tk-btc", amount: 0.08, usdValue: 0, kind: "spot", platform: "binance", note },
        { tokenId: "tk-eth", amount: 1, usdValue: 0, kind: "spot", platform: "binance" }, // 无 note 的行
      ],
    });
    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(1);
    // balance 级 note 挂在该 balance 上(per-balance),safeParse 回单个 Note;无 note 的行为 undefined。
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-btc")!.note).toEqual(note);
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-eth")!.note).toBeUndefined();
    // account 级 note(Note[])从 snapshot.note safeParse。
    expect(latest[0]!.note).toEqual(accountNote);
  });

  it("writes many balances by chunking under D1's bound-parameter limit", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "evm",
      label: "Big wallet",
      creds: "x",
    });
    // 60 条余额 × 每行多列 = 数百绑定参数,远超 D1 单条 100 上限 → 必须分块,否则 "too many SQL variables"。
    const balances = Array.from({ length: 60 }, (_, i) => ({
      tokenId: `tk-${i}`,
      amount: i,
      usdValue: i * 2,
      kind: "spot" as const,
      platform: "binance",
    }));
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 1, totalUsd: 100, balances });

    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(1);
    expect(latest[0]!.balances).toHaveLength(60); // 全部分块写入、无丢失
  });

  it("returns only the latest snapshot per account, with its balances", async () => {
    const a1 = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A1",
      creds: "x",
    });
    const a2 = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A2",
      creds: "x",
    });
    // 一个没有快照的账户:不应出现在结果里。
    await accounts(USER_A).create({ connectorId: "manual", label: "A3", creds: "x" });

    // a1:先旧后新两份快照 → 应只回最新那份(takenAt 2000),余额是 NEW 不是 OLD。
    await snapshotsOf(USER_A).write(a1.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ tokenId: "tk-old", amount: 1, usdValue: 10, kind: "spot", platform: "binance" }],
    });
    await snapshotsOf(USER_A).write(a1.id, {
      takenAt: 2000,
      totalUsd: 20,
      balances: [{ tokenId: "tk-new", amount: 2, usdValue: 20, kind: "spot", platform: "binance" }],
    });
    // a2:单份快照。
    await snapshotsOf(USER_A).write(a2.id, {
      takenAt: 1500,
      totalUsd: 5,
      balances: [{ tokenId: "tk-atom", amount: 5, usdValue: 5, kind: "spot", platform: "binance" }],
    });

    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(2); // a3 无快照 → 不计

    const byAcc = new Map(latest.map((r) => [r.snapshot.accountId, r]));
    const r1 = byAcc.get(a1.id)!;
    expect(r1.snapshot.takenAt).toBe(2000);
    expect(r1.snapshot.totalUsd).toBe(20);
    expect(r1.balances).toHaveLength(1);
    expect(r1.balances[0]!.tokenId).toBe("tk-new"); // 旧快照的 OLD 不应混入

    const r2 = byAcc.get(a2.id)!;
    expect(r2.snapshot.takenAt).toBe(1500);
    expect(r2.balances[0]!.tokenId).toBe("tk-atom");
  });

  it("returns [] for a user with no snapshots", async () => {
    await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    expect(await snapshotsOf(USER_A).latest()).toEqual([]);
  });

  it("cascades snapshots when the account is deleted", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1,
      totalUsd: 1,
      balances: [{ tokenId: "tk-x", amount: 1, usdValue: 1, kind: "spot", platform: "binance" }],
    });

    await accounts(USER_A).remove(acc.id);
    expect(await accounts(USER_A).list()).toHaveLength(0); // account gone
    expect(await snapshotsOf(USER_A).latest()).toHaveLength(0); // snapshots gone
  });

  it("lists all snapshot totals for a user, ascending by takenAt, scoped to the user", async () => {
    const a1 = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A1",
      creds: "x",
    });
    const a2 = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A2",
      creds: "x",
    });
    const b1 = await accounts(USER_B).create({
      connectorId: "manual",
      label: "B1",
      creds: "x",
    });
    // 跨账户、错时写入(乱序),验证升序返回。
    await snapshotsOf(USER_A).write(a1.id, { takenAt: 2000, totalUsd: 20, balances: [] });
    await snapshotsOf(USER_A).write(a1.id, { takenAt: 1000, totalUsd: 10, balances: [] });
    await snapshotsOf(USER_A).write(a2.id, { takenAt: 1500, totalUsd: 5, balances: [] });
    await snapshotsOf(USER_B).write(b1.id, { takenAt: 1200, totalUsd: 999, balances: [] });

    const totals = await snapshotsOf(USER_A).listTotals();
    expect(totals.map((t) => t.takenAt)).toEqual([1000, 1500, 2000]); // 升序、不含 user B
    expect(totals.map((t) => t.totalUsd)).toEqual([10, 5, 20]);
    expect(totals.find((t) => t.accountId === b1.id)).toBeUndefined();
  });

  it("returns [] of totals for a user with no snapshots", async () => {
    await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    expect(await snapshotsOf(USER_A).listTotals()).toEqual([]);
  });

  it("paginates snapshots (asc takenAt) and fetches balances by id (export)", async () => {
    const a = await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    const b1 = await accounts(USER_B).create({
      connectorId: "manual",
      label: "B",
      creds: "x",
    });
    for (const t of [3000, 1000, 2000]) {
      await snapshotsOf(USER_A).write(a.id, {
        takenAt: t,
        totalUsd: t,
        balances: [
          { tokenId: `tk-${t}`, amount: 1, usdValue: t, kind: "spot", platform: "binance" },
        ],
      });
    }
    await snapshotsOf(USER_B).write(b1.id, { takenAt: 9, totalUsd: 9, balances: [] });

    const page1 = await snapshotsOf(USER_A).listPage(2, 0);
    const page2 = await snapshotsOf(USER_A).listPage(2, 2);
    expect(page1.map((s) => s.takenAt)).toEqual([1000, 2000]); // asc, user A only
    expect(page2.map((s) => s.takenAt)).toEqual([3000]);
    expect(page2[0]!.accountId).toBe(a.id); // 不含 user B

    const bal = await snapshotsOf(USER_A).balancesFor(page1.map((s) => s.id));
    expect(bal).toHaveLength(2);
    expect(await snapshotsOf(USER_A).balancesFor([])).toEqual([]);
  });
});

describe("cross-user isolation", () => {
  it("never leaks another user's data", async () => {
    const a = await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    await snapshotsOf(USER_A).write(a.id, { takenAt: 1, totalUsd: 1, balances: [] });

    expect(await accounts(USER_B).list()).toHaveLength(0);
    expect(await accounts(USER_B).getById(a.id)).toBeNull();
    expect(await accounts(USER_B).getRawCreds(a.id)).toBeNull();

    await expect(snapshotsOf(USER_B).listByAccount(a.id)).rejects.toThrow();
    await expect(snapshotsOf(USER_B).listTotalsByAccount(a.id)).rejects.toThrow();
    await expect(
      snapshotsOf(USER_B).write(a.id, { takenAt: 2, totalUsd: 2, balances: [] }),
    ).rejects.toThrow();
  });
});

describe("user settings", () => {
  it("读带缺省:无行 → self-first", async () => {
    expect(await settings(USER_A).get()).toEqual({
      valuationMode: "self-first",
    });
  });

  it("upsert 覆盖 valuationMode;读回一致", async () => {
    await settings(USER_A).update({ valuationMode: "source-first" });
    expect(await settings(USER_A).get()).toEqual({
      valuationMode: "source-first",
    });
  });

  it("按 userId 隔离", async () => {
    await settings(USER_A).update({ valuationMode: "source-first" });
    expect((await settings(USER_B).get()).valuationMode).toBe("self-first");
  });
});
