import { env } from "cloudflare:test";
import type { ConnectorId } from "@folio/connectors";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountRecord,
  groupRecord,
  manualActivityRecord,
  membershipRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
  tokenRecord,
} from "../../src/lib/export";
import { buildPortfolioHistory } from "../../src/lib/history";
import { createImporter, type ImportDeps, parseImportLine } from "../../src/lib/import";
import { db } from "../../src/lib/server/internal/db";

// #204 的核心验收:**导出的文件能单独导进一个空库,总资产与历史曲线跟原库一致**。
// 走真 wire 路径:导出 → ndjsonLine 串成文本 → parseImportLine 解回 → 单遍导入到一个全新用户。
// 真 D1(Miniflare)。不隔离每测存储 → beforeEach 重置两个用户。

const SRC = "user-export-src";
const DST = "user-import-dst";

async function resetUser(userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(userId, userId, `${userId}@example.com`, 0, now, now)
    .run();
}

beforeEach(async () => {
  await resetUser(SRC);
  await resetUser(DST);
});

// 复刻 route 的导出流(#204):meta → token → account → group → membership → snapshot → activity。
async function exportRecords(userId: string): Promise<unknown[]> {
  const recs: unknown[] = [metaRecord(1_700_000_000_000)];
  for (const t of await db.listTokensForExport(userId)) recs.push(tokenRecord(t));
  for (const a of await db.listAccountsByUser(userId)) {
    const raw = await db.getRawCreds(userId, a.id);
    recs.push(accountRecord(a, raw ? JSON.parse(raw) : {}));
  }
  for (const g of await db.listGroupsByUser(userId)) recs.push(groupRecord(g));
  for (const m of await db.listMembershipsByUser(userId)) recs.push(membershipRecord(m));
  const page = await db.listSnapshotsPageByUser(userId, 1000, 0);
  const bals = await db.listBalancesForSnapshots(page.map((s) => s.id));
  const bySnap = new Map<string, typeof bals>();
  for (const b of bals) {
    const arr = bySnap.get(b.snapshotId);
    if (arr) arr.push(b);
    else bySnap.set(b.snapshotId, [b]);
  }
  for (const s of page) recs.push(snapshotRecord(s, bySnap.get(s.id) ?? []));
  for (const a of await db.listManualActivityByUser(userId)) recs.push(manualActivityRecord(a));
  return recs;
}

// route 的导入 deps,绑到 DST 用户。全走 import*(按内容自然键 find-or-create,幂等/可合并)。
const dstDeps: ImportDeps = {
  categorize: (connectorId) =>
    connectorId === "evm"
      ? { publicKeys: ["address"], semiKeys: [], secretKeys: [] }
      : { publicKeys: [], semiKeys: [], secretKeys: [] },
  importToken: async (t, refs) => ({ id: await db.importToken(DST, t, refs) }),
  importAccount: (input) =>
    db.importAccount(DST, { ...input, connectorId: input.connectorId as ConnectorId }),
  importGroup: (input) => db.importGroup(DST, input),
  addAccountToGroup: (accountId, groupId) => db.addAccountToGroup(DST, accountId, groupId),
  importSnapshot: async (accountId, input) => {
    await db.importSnapshot(DST, accountId, input);
  },
  importManualActivity: async (accountId, tokenId, input) => {
    await db.importManualActivity(DST, accountId, tokenId, input);
  },
};

async function importInto(records: unknown[]): Promise<void> {
  const text = records.map(ndjsonLine).join("");
  const imp = createImporter(dstDeps);
  for (const line of text.split("\n")) {
    const rec = parseImportLine(line);
    if (rec) await imp.apply(rec);
  }
}

// —— 造源库数据 ——
async function seedSource() {
  const accW = await db.createAccount(SRC, {
    connectorId: "evm",
    platform: "evm:1",
    label: "Wallet",
    creds: JSON.stringify({ address: "0xabc" }),
  });
  const accM = await db.createAccount(SRC, {
    connectorId: "manual",
    platform: "manual",
    label: "Manual",
    creds: JSON.stringify({}),
  });
  // 一个归档账户(无快照):验证归档态随导出/导入保真,不会变回活跃(#204 review 发现)。
  const accArch = await db.createAccount(SRC, {
    connectorId: "evm",
    platform: "evm:1",
    label: "Archived",
    creds: JSON.stringify({ address: "0xarch" }),
  });
  await db.setArchived(SRC, accArch.id, true);
  const btc = await db.importToken(
    SRC,
    { symbol: "BTC", name: "Bitcoin", logo: "b.png", providerLogo: null, marketCapRank: 1 },
    [{ namer: "coingecko", localName: "issued:bitcoin" }],
  );
  const eth = await db.importToken(SRC, { symbol: "ETH", name: "Ethereum" }, [
    { namer: "coingecko", localName: "issued:ethereum" },
    { namer: "evm:1", localName: "contract:0xeee" },
  ]);
  const my = await db.importToken(SRC, { symbol: "MYCOIN", name: "My Coin" }, [
    { namer: "manual", localName: "custom:MYCOIN" },
  ]);
  // evm 账户两份快照(历史曲线两点)。
  await db.writeSnapshot(SRC, accW.id, {
    takenAt: 1000,
    totalUsd: 100,
    balances: [
      { tokenId: btc, amount: 0.001, usdValue: 60, kind: "spot", platform: "evm:1" },
      { tokenId: eth, amount: 0.02, usdValue: 40, kind: "spot", platform: "evm:1" },
    ],
  });
  await db.writeSnapshot(SRC, accW.id, {
    takenAt: 2000,
    totalUsd: 150,
    // 账户级 note(整钱包)
    note: [{ title: "Wallet note", content: "hi" }],
    balances: [
      {
        tokenId: btc,
        amount: 0.001,
        usdValue: 90,
        kind: "spot",
        platform: "evm:1",
        selfPrice: 90000, // 估值原料
        meta: { foo: "bar" }, // typed meta(perp coin 也走这条)
        note: { title: "Locked", content: "x" }, // balance 级 note
      },
      { tokenId: eth, amount: 0.02, usdValue: 60, kind: "spot", platform: "evm:1" },
    ],
  });
  // manual 账户不写快照(ADR 0018),只有账本。
  await db.recordManualActivity(SRC, accM.id, my, {
    kind: "add",
    amount: 10,
    price: 5,
    occurredAt: 500,
    createdAt: 100,
  });
  const g = await db.createGroup(SRC, { name: "Group" });
  await db.addAccountToGroup(SRC, accW.id, g.id);
  return { btc, eth, my };
}

const normTokens = (
  ts: { symbol: string; name: string; refs: { namer: string; localName: string }[] }[],
) =>
  ts
    .map((t) => ({
      symbol: t.symbol,
      name: t.name,
      refs: t.refs.map((r) => `${r.namer}/${r.localName}`).sort(),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

// 把一份导出记录归一成可比较的形状:去掉 exportedAt,把所有 id(token/account/group)换成内容键
// (导入侧 id 全新,直接比会不等)。用来验「导入后再导出 ≡ 原导出」这个不动点。
type Rec = Record<string, unknown>;
function normalizeExport(records: unknown[]): Rec[] {
  const recs = records as Rec[];
  const key = new Map<string, string>();
  for (const r of recs) {
    if (r.type === "token") key.set(`t:${r.id}`, `token:${String(r.symbol)}`);
    else if (r.type === "account") key.set(`a:${r.id}`, `acct:${String(r.label)}`);
    else if (r.type === "group") key.set(`g:${r.id}`, `group:${String(r.name)}`);
  }
  const t = (id: unknown) => key.get(`t:${String(id)}`);
  const a = (id: unknown) => key.get(`a:${String(id)}`);
  const g = (id: unknown) => key.get(`g:${String(id)}`);
  return recs
    .map((r): Rec => {
      if (r.type === "meta") {
        const { exportedAt, ...rest } = r;
        return rest;
      }
      if (r.type === "token") return { ...r, id: t(r.id) };
      if (r.type === "account")
        // archivedAt 的精确时间戳有意不保真(导入用 now 重归档);只比归档**状态**。
        return { ...r, id: a(r.id), archivedAt: r.archivedAt === undefined ? undefined : true };
      if (r.type === "group") return { ...r, id: g(r.id) };
      if (r.type === "membership")
        return { ...r, accountId: a(r.accountId), groupId: g(r.groupId) };
      if (r.type === "snapshot")
        return {
          ...r,
          accountId: a(r.accountId),
          balances: (r.balances as Rec[]).map((b) => ({ ...b, tokenId: t(b.tokenId) })),
        };
      if (r.type === "manualActivity")
        return { ...r, accountId: a(r.accountId), tokenId: t(r.tokenId) };
      return r;
    })
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
}

describe("export → import v3 往返(空库重建)", () => {
  it("Token(含 ref)完整复现,id 是新的、不跟源库撞", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const src = await db.listTokensForExport(SRC);
    const dst = await db.listTokensForExport(DST);
    expect(normTokens(dst)).toEqual(normTokens(src));
    // id 重映射:两边 id 集合无交集。
    const srcIds = new Set(src.map((t) => t.id));
    expect(dst.every((t) => !srcIds.has(t.id))).toBe(true);
  });

  it("账户 + creds(public)+ 分组关系复现", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstAccts = await db.listAccountsByUser(DST);
    expect(
      dstAccts
        .map((a) => ({ connectorId: a.connectorId, label: a.label, platform: a.platform }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    ).toEqual([
      { connectorId: "evm", label: "Archived", platform: "evm:1" },
      { connectorId: "manual", label: "Manual", platform: "manual" },
      { connectorId: "evm", label: "Wallet", platform: "evm:1" },
    ]);
    const wallet = dstAccts.find((a) => a.label === "Wallet")!;
    expect(JSON.parse((await db.getRawCreds(DST, wallet.id))!)).toEqual({ address: "0xabc" });
    expect(await db.listMembershipsByUser(DST)).toHaveLength(1);
    // 归档态保真:归档账户导入后仍归档,活跃账户仍活跃(#204 review 修复)。
    expect(dstAccts.find((a) => a.label === "Archived")!.archivedAt).toBeGreaterThan(0);
    expect(wallet.archivedAt).toBeNull();
  });

  it("估值原料 / meta / balance note / 账户级 note 端到端保真", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstTokens = await db.listTokensForExport(DST);
    const btcId = dstTokens.find((t) => t.symbol === "BTC")!.id;
    const latest = (await db.getLatestSnapshotByUser(DST))[0]!;
    expect(latest.note).toEqual([{ title: "Wallet note", content: "hi" }]); // 账户级 note
    const btcBal = latest.balances.find((b) => b.tokenId === btcId)!;
    expect(btcBal.selfPrice).toBe(90000);
    expect(JSON.parse(btcBal.metaJson ?? "{}")).toEqual({ foo: "bar" });
    expect(btcBal.note).toEqual({ title: "Locked", content: "x" });
  });

  it("历史曲线逐点一致(总资产同源)", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const srcHist = buildPortfolioHistory(await db.listSnapshotTotalsByUser(SRC));
    const dstHist = buildPortfolioHistory(await db.listSnapshotTotalsByUser(DST));
    expect(dstHist).toEqual(srcHist);
    // 冻结总资产(各账户最新快照之和)一致。
    const total = (snaps: { snapshot: { totalUsd: number } }[]) =>
      snaps.reduce((s, x) => s + x.snapshot.totalUsd, 0);
    expect(total(await db.getLatestSnapshotByUser(DST))).toBe(
      total(await db.getLatestSnapshotByUser(SRC)),
    );
  });

  it("快照余额的 token_id 重映射到 DST 的 Token,金额/价值不变", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstTokens = await db.listTokensForExport(DST);
    const symById = new Map(dstTokens.map((t) => [t.id, t.symbol]));
    const latest = await db.getLatestSnapshotByUser(DST);
    expect(latest).toHaveLength(1); // 只有 evm 账户有快照
    const bals = latest[0]!.balances;
    expect(bals).toHaveLength(2);
    // 每条余额的 token_id 都指向 DST 的 Token(不是源库 id)。
    const bySym = new Map(bals.map((b) => [symById.get(b.tokenId ?? ""), b]));
    expect(bySym.get("BTC")?.usdValue).toBe(90);
    expect(bySym.get("ETH")?.usdValue).toBe(60);
    expect(bySym.get("BTC")?.amount).toBe(0.001);
  });

  it("手记账本复现(kind/amount/price/occurredAt/createdAt 保留),挂到 DST 的 MYCOIN", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstAct = await db.listManualActivityByUser(DST);
    expect(dstAct).toHaveLength(1);
    expect(dstAct[0]).toMatchObject({
      kind: "add",
      amount: 10,
      price: 5,
      occurredAt: 500,
      createdAt: 100,
    });
    // tokenId 指向 DST 的 MYCOIN。
    const dstTokens = await db.listTokensForExport(DST);
    const mycoin = dstTokens.find((t) => t.symbol === "MYCOIN")!;
    expect(dstAct[0]!.tokenId).toBe(mycoin.id);
  });

  it("多链归一保持:ETH 的两条 ref(coingecko + evm:1)导入后仍是同一个 Token", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));
    const eth = (await db.listTokensForExport(DST)).find((t) => t.symbol === "ETH")!;
    expect(eth.refs).toHaveLength(2);
  });

  it("导入后再导出 ≡ 原导出(格式是不动点:归一掉 id/时间戳后逐条相等)", async () => {
    await seedSource();
    const srcExport = await exportRecords(SRC);
    await importInto(srcExport);
    const dstExport = await exportRecords(DST);
    expect(normalizeExport(dstExport)).toEqual(normalizeExport(srcExport));
  });

  it("幂等:同一文件导 3 次,库内数据不翻倍;且再导出 ≡ 原导出(A 方案不动点)", async () => {
    await seedSource();
    const file = await exportRecords(SRC);
    const srcNorm = normalizeExport(file);

    for (let i = 0; i < 3; i++) await importInto(file); // 反复导入同一文件

    // 各类实体计数不随导入次数增长(按内容自然键去重)。
    expect(await db.listAccountsByUser(DST)).toHaveLength(3);
    expect(await db.listTokensForExport(DST)).toHaveLength(3);
    expect(await db.listGroupsByUser(DST)).toHaveLength(1);
    expect(await db.listMembershipsByUser(DST)).toHaveLength(1);
    expect(await db.listManualActivityByUser(DST)).toHaveLength(1);
    const snapCount = (await db.listSnapshotsPageByUser(DST, 1000, 0)).length;
    expect(snapCount).toBe(2); // evm 账户两份快照,不重复
    // 手记不折叠翻倍:数量还是 10(不是 30)。
    expect((await db.listManualActivityByUser(DST))[0]!.amount).toBe(10);

    // 反复导入后再导出,归一后仍逐条等于原导出。
    expect(normalizeExport(await exportRecords(DST))).toEqual(srcNorm);
  });

  it("合并:两份不同来源的文件能并进同一库,各自数据都在", async () => {
    await seedSource();
    const fileA = await exportRecords(SRC);

    // 造第二份来源:一个新账户 + 新币 + 一笔账本,导出成 fileB。
    const OTHER = "user-export-other";
    await resetUser(OTHER);
    const accB = await db.createAccount(OTHER, {
      connectorId: "manual",
      platform: "manual",
      label: "OtherManual",
      creds: JSON.stringify({}),
    });
    const solId = await db.importToken(OTHER, { symbol: "SOL", name: "Solana" }, [
      { namer: "coingecko", localName: "issued:solana" },
    ]);
    await db.recordManualActivity(OTHER, accB.id, solId, {
      kind: "add",
      amount: 7,
      occurredAt: 900,
      createdAt: 200,
    });
    const fileB = await (async () => {
      const recs: unknown[] = [metaRecord(1_700_000_000_000)];
      for (const t of await db.listTokensForExport(OTHER)) recs.push(tokenRecord(t));
      for (const a of await db.listAccountsByUser(OTHER)) {
        const raw = await db.getRawCreds(OTHER, a.id);
        recs.push(accountRecord(a, raw ? JSON.parse(raw) : {}));
      }
      for (const a of await db.listManualActivityByUser(OTHER)) recs.push(manualActivityRecord(a));
      return recs;
    })();

    await importInto(fileA);
    await importInto(fileB);

    // A(3 账户)+ B(1 账户)= 4;币 3 + 1 = 4;账本 1 + 1 = 2。
    expect(await db.listAccountsByUser(DST)).toHaveLength(4);
    const dstTokens = await db.listTokensForExport(DST);
    expect(dstTokens.map((t) => t.symbol).sort()).toEqual(["BTC", "ETH", "MYCOIN", "SOL"]);
    expect(await db.listManualActivityByUser(DST)).toHaveLength(2);
  });
});
