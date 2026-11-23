import { env } from "cloudflare:test";
import type { ConnectorId } from "@folio/connectors";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { buildPortfolioHistory } from "@/lib/core/history";
import {
  accountRecord,
  manualActivityRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
  tokenRecord,
} from "@/lib/server/io/export";
import { createImporter, type ImportDeps, parseImportLine } from "@/lib/server/io/import";
import { dbFor } from "./db-effect";

// Core acceptance: an exported file imports alone into an empty DB with total assets and history curves matching the source.
// Real wire path: export -> ndjsonLine text -> parseImportLine -> single-pass import into a fresh user. Real D1 (Miniflare);
// storage not isolated per test, so beforeEach resets both users.

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

// Re-implements the route's export stream: meta -> token -> account -> snapshot -> activity.
async function exportRecords(userId: string): Promise<unknown[]> {
  const recs: unknown[] = [metaRecord(1_700_000_000_000)];
  for (const t of await dbFor(userId).transfer.listTokensForExport()) recs.push(tokenRecord(t));
  for (const a of await dbFor(userId).accounts.list()) {
    const raw = await dbFor(userId).accounts.getRawCreds(a.id);
    recs.push(accountRecord(a, raw ? JSON.parse(raw) : {}));
  }
  const page = await dbFor(userId).snapshots.listPage(1000, 0);
  const bals = await dbFor(userId).snapshots.balancesFor(page.map((s) => s.id));
  const bySnap = new Map<string, typeof bals>();
  for (const b of bals) {
    const arr = bySnap.get(b.snapshotId);
    if (arr) arr.push(b);
    else bySnap.set(b.snapshotId, [b]);
  }
  for (const s of page) recs.push(snapshotRecord(s, bySnap.get(s.id) ?? []));
  for (const a of await dbFor(userId).manual.listAllActivity()) recs.push(manualActivityRecord(a));
  return recs;
}

// The route's import deps bound to the DST user; all go through import* (find-or-create by content natural key, idempotent and mergeable).
const dstDeps: ImportDeps = {
  categorize: (connectorId) =>
    connectorId === "evm"
      ? { publicKeys: ["address"], semiKeys: [], secretKeys: [] }
      : { publicKeys: [], semiKeys: [], secretKeys: [] },
  // deps take Effects while the fixture only has the facade's Promises; wrapping in `Effect.promise` is a test-edge adapter.
  importToken: (t, refs) =>
    Effect.promise(async () => ({ id: await dbFor(DST).transfer.importToken(t, refs) })),
  importAccount: (input) =>
    Effect.promise(() =>
      dbFor(DST).transfer.importAccount({
        ...input,
        connectorId: input.connectorId as ConnectorId,
      }),
    ),
  importSnapshot: (accountId, input) =>
    Effect.promise(async () => {
      await dbFor(DST).transfer.importSnapshot(accountId, input);
    }),
  importManualActivity: (accountId, tokenId, input) =>
    Effect.promise(async () => {
      await dbFor(DST).transfer.importManualActivity(accountId, tokenId, input);
    }),
};

async function importInto(records: unknown[]): Promise<void> {
  const text = records.map(ndjsonLine).join("");
  const imp = createImporter(dstDeps);
  for (const line of text.split("\n")) {
    const rec = parseImportLine(line);
    if (rec) await Effect.runPromise(imp.apply(rec));
  }
}

// -- seed the source DB --
async function seedSource() {
  const accW = await dbFor(SRC).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label: "Wallet",
    creds: JSON.stringify({ address: "0xabc" }),
  });
  const accM = await dbFor(SRC).accounts.create({
    connectorId: "manual",
    platform: "manual",
    label: "Manual",
    creds: JSON.stringify({}),
  });
  // An archived account (no snapshots): archived state must survive export/import and not turn active again.
  const accArch = await dbFor(SRC).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label: "Archived",
    creds: JSON.stringify({ address: "0xarch" }),
  });
  await dbFor(SRC).accounts.setArchived(accArch.id, true);
  const btc = await dbFor(SRC).transfer.importToken(
    { symbol: "BTC", name: "Bitcoin", logo: "b.png", providerLogo: null, marketCapRank: 1 },
    [{ namer: "coingecko", localName: "issued:bitcoin" }],
  );
  const eth = await dbFor(SRC).transfer.importToken({ symbol: "ETH", name: "Ethereum" }, [
    { namer: "coingecko", localName: "issued:ethereum" },
    { namer: "evm:1", localName: "contract:0xeee" },
  ]);
  const my = await dbFor(SRC).transfer.importToken({ symbol: "MYCOIN", name: "My Coin" }, [
    { namer: "manual", localName: "custom:MYCOIN" },
  ]);
  // evm account with two snapshots (two history points).
  await dbFor(SRC).snapshots.write(accW.id, {
    takenAt: 1000,
    totalUsd: 100,
    balances: [
      { tokenId: btc, amount: 0.001, usdValue: 60, kind: "spot", platform: "evm:1" },
      { tokenId: eth, amount: 0.02, usdValue: 40, kind: "spot", platform: "evm:1" },
    ],
  });
  await dbFor(SRC).snapshots.write(accW.id, {
    takenAt: 2000,
    totalUsd: 150,
    // account-level note (whole wallet)
    note: [{ title: "Wallet note", content: "hi" }],
    balances: [
      {
        tokenId: btc,
        amount: 0.001,
        usdValue: 90,
        kind: "spot",
        platform: "evm:1",
        selfPrice: 90000, // valuation input
        meta: { foo: "bar" }, // typed meta (perp coin takes this path too)
        note: { title: "Locked", content: "x" }, // balance-level note
      },
      { tokenId: eth, amount: 0.02, usdValue: 60, kind: "spot", platform: "evm:1" },
    ],
  });
  // manual accounts write no snapshots, only a ledger.
  await dbFor(SRC).manual.recordActivity(accM.id, my, {
    kind: "add",
    amount: 10,
    price: 5,
    occurredAt: 500,
    createdAt: 100,
  });
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

// Normalizes an export to a comparable shape: drops exportedAt and replaces all ids (token/account) with content keys
// (import-side ids are fresh), to verify the "import then export == original export" fixed point.
type Rec = Record<string, unknown>;
function normalizeExport(records: unknown[]): Rec[] {
  const recs = records as Rec[];
  const key = new Map<string, string>();
  for (const r of recs) {
    if (r.type === "token") key.set(`t:${r.id}`, `token:${String(r.symbol)}`);
    else if (r.type === "account") key.set(`a:${r.id}`, `acct:${String(r.label)}`);
  }
  const t = (id: unknown) => key.get(`t:${String(id)}`);
  const a = (id: unknown) => key.get(`a:${String(id)}`);
  return recs
    .map((r): Rec => {
      if (r.type === "meta") {
        const { exportedAt, ...rest } = r;
        return rest;
      }
      if (r.type === "token") return { ...r, id: t(r.id) };
      if (r.type === "account")
        // archivedAt's exact timestamp isn't preserved (import re-archives with now); only the archived state is compared.
        return { ...r, id: a(r.id), archivedAt: r.archivedAt === undefined ? undefined : true };
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

describe("export -> import v3 roundtrip (rebuild into an empty DB)", () => {
  // Compare ref sets per Token; multi-chain normalization (ETH's coingecko + evm:1 refs on one Token) is pinned here too.
  it("Token (with refs) fully reproduced, ids are new and don't collide with the source", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const src = await dbFor(SRC).transfer.listTokensForExport();
    const dst = await dbFor(DST).transfer.listTokensForExport();
    expect(normTokens(dst)).toEqual(normTokens(src));
    // id remap: the two sides' id sets are disjoint.
    const srcIds = new Set(src.map((t) => t.id));
    expect(dst.every((t) => !srcIds.has(t.id))).toBe(true);
  });

  it("accounts + creds (public) reproduced", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstAccts = await dbFor(DST).accounts.list();
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
    expect(JSON.parse((await dbFor(DST).accounts.getRawCreds(wallet.id))!)).toEqual({
      address: "0xabc",
    });
    // Archived state preserved: archived accounts stay archived after import, active ones stay active.
    expect(dstAccts.find((a) => a.label === "Archived")!.archivedAt).toBeGreaterThan(0);
    expect(wallet.archivedAt).toBeNull();
  });

  it("valuation inputs / meta / balance note / account-level note preserved end to end", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstTokens = await dbFor(DST).transfer.listTokensForExport();
    const btcId = dstTokens.find((t) => t.symbol === "BTC")!.id;
    const latest = (await dbFor(DST).snapshots.latest())[0]!;
    expect(latest.note).toEqual([{ title: "Wallet note", content: "hi" }]); // account-level note
    const btcBal = latest.balances.find((b) => b.tokenId === btcId)!;
    expect(btcBal.selfPrice).toBe(90000);
    expect(JSON.parse(btcBal.metaJson ?? "{}")).toEqual({ foo: "bar" });
    expect(btcBal.note).toEqual({ title: "Locked", content: "x" });
  });

  it("history curve matches point by point (same total-assets source)", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const srcHist = buildPortfolioHistory(await dbFor(SRC).snapshots.listTotals());
    const dstHist = buildPortfolioHistory(await dbFor(DST).snapshots.listTotals());
    expect(dstHist).toEqual(srcHist);
    // Frozen total assets (sum of each account's latest snapshot) match.
    const total = (snaps: { snapshot: { totalUsd: number } }[]) =>
      snaps.reduce((s, x) => s + x.snapshot.totalUsd, 0);
    expect(total(await dbFor(DST).snapshots.latest())).toBe(
      total(await dbFor(SRC).snapshots.latest()),
    );
  });

  it("snapshot balances' token_id remapped to DST's Token, amount/value unchanged", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstTokens = await dbFor(DST).transfer.listTokensForExport();
    const symById = new Map(dstTokens.map((t) => [t.id, t.symbol]));
    const latest = await dbFor(DST).snapshots.latest();
    expect(latest).toHaveLength(1); // only the evm account has snapshots
    const bals = latest[0]!.balances;
    expect(bals).toHaveLength(2);
    // Each balance's token_id points at DST's Token (not the source id).
    const bySym = new Map(bals.map((b) => [symById.get(b.tokenId ?? ""), b]));
    expect(bySym.get("BTC")?.usdValue).toBe(90);
    expect(bySym.get("ETH")?.usdValue).toBe(60);
    expect(bySym.get("BTC")?.amount).toBe(0.001);
  });

  it("manual ledger reproduced (kind/amount/price/occurredAt/createdAt kept), attached to DST's MYCOIN", async () => {
    await seedSource();
    await importInto(await exportRecords(SRC));

    const dstAct = await dbFor(DST).manual.listAllActivity();
    expect(dstAct).toHaveLength(1);
    expect(dstAct[0]).toMatchObject({
      kind: "add",
      amount: 10,
      price: 5,
      occurredAt: 500,
      createdAt: 100,
    });
    // tokenId points at DST's MYCOIN.
    const dstTokens = await dbFor(DST).transfer.listTokensForExport();
    const mycoin = dstTokens.find((t) => t.symbol === "MYCOIN")!;
    expect(dstAct[0]!.tokenId).toBe(mycoin.id);
  });

  it("import then export == original export (format is a fixed point: equal entry by entry after normalizing id/timestamps)", async () => {
    await seedSource();
    const srcExport = await exportRecords(SRC);
    await importInto(srcExport);
    const dstExport = await exportRecords(DST);
    expect(normalizeExport(dstExport)).toEqual(normalizeExport(srcExport));
  });

  it("idempotent: importing the same file 3 times doesn't double the data; re-export == original export", async () => {
    await seedSource();
    const file = await exportRecords(SRC);
    const srcNorm = normalizeExport(file);

    for (let i = 0; i < 3; i++) await importInto(file); // repeatedly import the same file

    // Entity counts don't grow with import count (deduped by content natural key).
    expect(await dbFor(DST).accounts.list()).toHaveLength(3);
    expect(await dbFor(DST).transfer.listTokensForExport()).toHaveLength(3);
    expect(await dbFor(DST).manual.listAllActivity()).toHaveLength(1);
    const snapCount = (await dbFor(DST).snapshots.listPage(1000, 0)).length;
    expect(snapCount).toBe(2); // evm account, two snapshots, no duplicates
    // Manual doesn't fold-double: quantity is still 10 (not 30).
    expect((await dbFor(DST).manual.listAllActivity())[0]!.amount).toBe(10);

    // After repeated imports, re-export normalizes to exactly the original export.
    expect(normalizeExport(await exportRecords(DST))).toEqual(srcNorm);
  });

  it("merge: files from two different sources merge into one DB, each one's data kept", async () => {
    await seedSource();
    const fileA = await exportRecords(SRC);

    // Build a second source: a new account + new coin + a ledger entry, exported as fileB.
    const OTHER = "user-export-other";
    await resetUser(OTHER);
    const accB = await dbFor(OTHER).accounts.create({
      connectorId: "manual",
      platform: "manual",
      label: "OtherManual",
      creds: JSON.stringify({}),
    });
    const solId = await dbFor(OTHER).transfer.importToken({ symbol: "SOL", name: "Solana" }, [
      { namer: "coingecko", localName: "issued:solana" },
    ]);
    await dbFor(OTHER).manual.recordActivity(accB.id, solId, {
      kind: "add",
      amount: 7,
      occurredAt: 900,
      createdAt: 200,
    });
    const fileB = await (async () => {
      const recs: unknown[] = [metaRecord(1_700_000_000_000)];
      for (const t of await dbFor(OTHER).transfer.listTokensForExport()) recs.push(tokenRecord(t));
      for (const a of await dbFor(OTHER).accounts.list()) {
        const raw = await dbFor(OTHER).accounts.getRawCreds(a.id);
        recs.push(accountRecord(a, raw ? JSON.parse(raw) : {}));
      }
      for (const a of await dbFor(OTHER).manual.listAllActivity())
        recs.push(manualActivityRecord(a));
      return recs;
    })();

    await importInto(fileA);
    await importInto(fileB);

    // A (3 accounts) + B (1 account) = 4; coins 3 + 1 = 4; ledger 1 + 1 = 2.
    expect(await dbFor(DST).accounts.list()).toHaveLength(4);
    const dstTokens = await dbFor(DST).transfer.listTokensForExport();
    expect(dstTokens.map((t) => t.symbol).sort()).toEqual(["BTC", "ETH", "MYCOIN", "SOL"]);
    expect(await dbFor(DST).manual.listAllActivity()).toHaveLength(2);
  });
});
