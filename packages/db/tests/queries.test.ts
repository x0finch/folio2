import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
// In-package tests may use the package-private handle: the userId to user FK is enforced, so business rows need a user row first.
import { user } from "../src/schema/auth";
import { forDomain, forGlobal } from "./effect"; // white-box in-package tests: the public surface exports only the aggregate tickets (see encapsulation.test)

const snapshotsOf = forDomain((db) => db.snapshots);

const accounts = forDomain((db) => db.accounts);
// The cron path has no userId, so it lives on `GlobalDatabase`.
const globalAccounts = forGlobal((db) => db.accounts);

const USER_A = "user-a";
const USER_B = "user-b";

// pool-workers doesn't isolate storage per test: before each test, delete the user row (cascades accounts/portfolios/snapshots/...) and insert a clean one (satisfies the userId FK).
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
    expect(await globalAccounts().listUserIds()).toEqual([]); // no accounts
    await accounts(USER_A).create({ connectorId: "manual", label: "A1", creds: "x" });
    await accounts(USER_A).create({ connectorId: "manual", label: "A2", creds: "x" }); // two accounts for one user: deduped
    await accounts(USER_B).create({ connectorId: "manual", label: "B1", creds: "x" });
    const ids = await globalAccounts().listUserIds();
    expect([...ids].sort()).toEqual([USER_A, USER_B].sort());
  });

  it("round-trips the creds map (incl. semi_ placeholder) and rehydrates via setAccountCredentials", async () => {
    // Imported CEX missing credentials: creds holds only masked semi placeholders (no real apiKey/secret).
    const imported = JSON.stringify({ semi_apiKey: "ABCD…5678" });
    const acc = await accounts(USER_A).create({
      connectorId: "okx",
      label: "Imported OKX",
      creds: imported,
    });
    expect(await accounts(USER_A).getRawCreds(acc.id)).toBe(imported);
    // creds never enter the safe shape (they hold secret ciphertext).
    const got = await accounts(USER_A).getById(acc.id);
    expect(Object.keys(got!)).not.toContain("creds");

    // Backfill: the whole map is overwritten.
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
    // Foreign ownership: another user can't change it.
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

  it("listRawCredsByUser returns each account's raw creds (user-scoped; for safeView enrichment)", async () => {
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
      // symbol isn't stored on snapshots; rows are told apart by token_id.
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
    // With no note written, each row's note is omitted.
    expect(latest[0]!.balances.every((b) => b.note === undefined)).toBe(true);
    // self_price round-trips: the BTC row has it, the ETH row doesn't (null).
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-btc")!.selfPrice).toBe(100000);
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-eth")!.selfPrice).toBeNull();
  });

  // asOf (the 24h P&L start): per account, the nearest snapshot in `[floor, t]` plus its balances. It is <= t, not >= t (a later one would pass hours-old numbers as 24h ago), and the floor drops accounts with no snapshot in the window.
  it("asOf: takes the nearest in the [floor, t] window; later ones don't stand in, ones outside don't appear", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "binance", label: "B", creds: "x" });
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1000,
      totalUsd: 10,
      balances: [{ amount: 1, usdValue: 10, kind: "spot", tokenId: "tk-btc" }],
    });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 2000, totalUsd: 20, balances: [] });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 3000, totalUsd: 30, balances: [] });

    // t=2500, floor=0: the nearest <= 2500 is 2000 (3000 must not stand in).
    const at2500 = await snapshotsOf(USER_A).asOf(2500, 0);
    expect(at2500).toHaveLength(1);
    expect(at2500[0]!.snapshot.takenAt).toBe(2000);

    // Equal to t counts (<=).
    expect((await snapshotsOf(USER_A).asOf(1000, 0))[0]!.snapshot.takenAt).toBe(1000);
    expect((await snapshotsOf(USER_A).asOf(1000, 0))[0]!.balances).toHaveLength(1);

    // floor bounds the window: t=2500 but floor=2100 means nothing in [2100,2500], so absent.
    expect(await snapshotsOf(USER_A).asOf(2500, 2100)).toEqual([]);
    // Earlier than the earliest: empty.
    expect(await snapshotsOf(USER_A).asOf(500, 0)).toEqual([]);
  });

  // Source for per-account curves: two columns plus a `since` window, which is this read's upper bound: it emits points as-is, so without trimming the size would track history.
  it("listTotalsByAccount: trims by since, ascending, returns only (takenAt, totalUsd)", async () => {
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
    // The window is in SQL, not filtered after the query: the row outside the window never leaves the db.
    expect(await snapshotsOf(USER_A).listTotalsByAccount(acc.id, 200)).toEqual([
      { takenAt: 200, totalUsd: 20 },
      { takenAt: 300, totalUsd: 30 },
    ]);
    expect(await snapshotsOf(USER_A).listTotalsByAccount(acc.id, 999)).toEqual([]);
  });

  it("listTokenValueTotals: per-token spot total per (account x snapshot), window + bucket in SQL", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "binance", label: "B", creds: "x" });
    const other = await accounts(USER_B).create({ connectorId: "binance", label: "X", creds: "x" });
    const DAY = 86_400_000;
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 100,
      totalUsd: 30,
      balances: [
        { tokenId: "tk-btc", amount: 1, usdValue: 10, kind: "spot", platform: "binance" },
        // The same coin on two chains in one snapshot: summed
        { tokenId: "tk-btc", amount: 1, usdValue: 5, kind: "spot", platform: "ethereum" },
        // Non-spot doesn't count (matches viewKind)
        { tokenId: "tk-btc", amount: 1, usdValue: 99, kind: "defi", platform: "binance" },
        { tokenId: "tk-eth", amount: 1, usdValue: 20, kind: "spot", platform: "binance" },
      ],
    });
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 300,
      totalUsd: 40,
      balances: [{ tokenId: "tk-btc", amount: 1, usdValue: 30, kind: "spot", platform: "binance" }],
    });
    await snapshotsOf(USER_A).write(acc.id, {
      takenAt: DAY + 5,
      totalUsd: 40,
      balances: [{ tokenId: "tk-btc", amount: 1, usdValue: 40, kind: "spot", platform: "binance" }],
    });
    await snapshotsOf(USER_B).write(other.id, {
      takenAt: 200,
      totalUsd: 1,
      balances: [{ tokenId: "tk-btc", amount: 1, usdValue: 1, kind: "spot", platform: "binance" }],
    });

    const store = snapshotsOf(USER_A);
    expect(await store.listTokenValueTotals("tk-btc", undefined, "snapshot")).toEqual([
      { accountId: acc.id, takenAt: 100, totalUsd: 15 },
      { accountId: acc.id, takenAt: 300, totalUsd: 30 },
      { accountId: acc.id, takenAt: DAY + 5, totalUsd: 40 },
    ]);
    expect(await store.listTokenValueTotals("tk-btc", 200, "snapshot")).toEqual([
      { accountId: acc.id, takenAt: 300, totalUsd: 30 },
      { accountId: acc.id, takenAt: DAY + 5, totalUsd: 40 },
    ]);
    // Per day: keep each account's last row per UTC day.
    expect(await store.listTokenValueTotals("tk-btc", undefined, "day")).toEqual([
      { accountId: acc.id, takenAt: 300, totalUsd: 30 },
      { accountId: acc.id, takenAt: DAY + 5, totalUsd: 40 },
    ]);
    const sampled = await store.listTokenValueTotals("tk-btc", undefined, "sampled");
    expect(sampled.at(-1)).toEqual({ accountId: acc.id, takenAt: DAY + 5, totalUsd: 40 });
    expect(await store.listTokenValueTotals("tk-doge", undefined, "snapshot")).toEqual([]);
  });

  it("latestRaw / asOfRaw: the same snapshots as latest / asOf, raw tuples, notes unparsed", async () => {
    const a = await accounts(USER_A).create({ connectorId: "binance", label: "A", creds: "x" });
    const b = await accounts(USER_A).create({ connectorId: "binance", label: "B", creds: "x" });
    const theirs = await accounts(USER_B).create({
      connectorId: "binance",
      label: "X",
      creds: "x",
    });
    const note = [{ title: "t", content: "c" }];
    await snapshotsOf(USER_A).write(a.id, {
      takenAt: 100,
      totalUsd: 1,
      balances: [{ tokenId: "tk-old", amount: 1, usdValue: 1, kind: "spot" }],
    });
    await snapshotsOf(USER_A).write(a.id, {
      takenAt: 200,
      totalUsd: 30,
      note,
      balances: [
        {
          tokenId: "tk-btc",
          amount: 2,
          usdValue: 20,
          kind: "spot",
          platform: "binance",
          selfPrice: 10,
        },
        { tokenId: "tk-lp", amount: 1, usdValue: 10, kind: "defi", meta: { protocol: "x" } },
      ],
    });
    await snapshotsOf(USER_A).write(b.id, { takenAt: 150, totalUsd: 5, balances: [] });
    await snapshotsOf(USER_B).write(theirs.id, { takenAt: 300, totalUsd: 9, balances: [] });

    const raw = await snapshotsOf(USER_A).latestRaw();
    expect([...raw.snapshots].sort((x, y) => x[1] - y[1])).toEqual([
      [b.id, 150, 5, null],
      [a.id, 200, 30, JSON.stringify(note)],
    ]);
    expect(
      raw.balances.map(([acc, , amount, usd, kind, self, platform, token, meta]) => [
        acc,
        amount,
        usd,
        kind,
        self,
        platform,
        token,
        meta,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [a.id, 2, 20, "spot", 10, "binance", "tk-btc", null],
        [a.id, 1, 10, "defi", null, null, "tk-lp", JSON.stringify({ protocol: "x" })],
      ]),
    );
    expect(raw.balances).toHaveLength(2);

    // Same window rule: the newest in [floor, t]; accounts with none in the window are absent.
    const prev = await snapshotsOf(USER_A).asOfRaw(120, 50);
    expect(prev.snapshots).toEqual([[a.id, 100, 1, null]]);
    expect(prev.balances.map((r) => r[7])).toEqual(["tk-old"]);
    const parsed = await snapshotsOf(USER_A).asOf(120, 50);
    expect(parsed.map((s) => s.snapshot.accountId)).toEqual([a.id]);
  });

  it("persists per-balance note (single Note) + account-level note (Note[]) and safeParses back", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "bitcoin",
      label: "BTC",
      creds: "x",
    });
    // Balance-level: a single Note (a CEX locked-balance example).
    const note = {
      title: "Locked",
      icon: "warning" as const,
      content: [{ label: "BTC", value: 0.005, unit: "BTC" }],
    };
    // Account-level: Note[] (whole wallet).
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
        { tokenId: "tk-eth", amount: 1, usdValue: 0, kind: "spot", platform: "binance" }, // row without a note
      ],
    });
    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(1);
    // Balance-level note hangs on that balance (per balance), safeParses back to a single Note; a row without one is undefined.
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-btc")!.note).toEqual(note);
    expect(latest[0]!.balances.find((b) => b.tokenId === "tk-eth")!.note).toBeUndefined();
    // Account-level note (Note[]) is read from snapshot.note via safeParse.
    expect(latest[0]!.note).toEqual(accountNote);
  });

  it("writes many balances by chunking under D1's bound-parameter limit", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "evm",
      label: "Big wallet",
      creds: "x",
    });
    // 60 balances x several columns = hundreds of bound params, far above D1's 100 per statement: must chunk, or "too many SQL variables".
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
    expect(latest[0]!.balances).toHaveLength(60); // all written in chunks, none lost
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
    // An account with no snapshots must not appear in the result.
    await accounts(USER_A).create({ connectorId: "manual", label: "A3", creds: "x" });

    // a1: older then newer snapshot: only the latest comes back (takenAt 2000), balances NEW not OLD.
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
    // a2: a single snapshot.
    await snapshotsOf(USER_A).write(a2.id, {
      takenAt: 1500,
      totalUsd: 5,
      balances: [{ tokenId: "tk-atom", amount: 5, usdValue: 5, kind: "spot", platform: "binance" }],
    });

    const latest = await snapshotsOf(USER_A).latest();
    expect(latest).toHaveLength(2); // a3 has no snapshots: not counted

    const byAcc = new Map(latest.map((r) => [r.snapshot.accountId, r]));
    const r1 = byAcc.get(a1.id)!;
    expect(r1.snapshot.takenAt).toBe(2000);
    expect(r1.snapshot.totalUsd).toBe(20);
    expect(r1.balances).toHaveLength(1);
    expect(r1.balances[0]!.tokenId).toBe("tk-new"); // OLD from the older snapshot must not leak in

    const r2 = byAcc.get(a2.id)!;
    expect(r2.snapshot.takenAt).toBe(1500);
    expect(r2.balances[0]!.tokenId).toBe("tk-atom");
  });

  // Same-millisecond ties (only non-collapsing writes produce them): exactly one per account, the later write; latest and asOf follow one rule.
  it("same-ms tie: exactly one snapshot per account, the later-written one", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    await snapshotsOf(USER_A).write(acc.id, { takenAt: 1000, totalUsd: 1, balances: [] });
    const second = await snapshotsOf(USER_A).write(acc.id, {
      takenAt: 1000,
      totalUsd: 2,
      balances: [],
    });

    for (const rows of [
      await snapshotsOf(USER_A).latest(),
      await snapshotsOf(USER_A).asOf(1000, 0),
    ]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]!.snapshot.id).toBe(second);
    }
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
    // Cross-account, out-of-order writes: verifies ascending return.
    await snapshotsOf(USER_A).write(a1.id, { takenAt: 2000, totalUsd: 20, balances: [] });
    await snapshotsOf(USER_A).write(a1.id, { takenAt: 1000, totalUsd: 10, balances: [] });
    await snapshotsOf(USER_A).write(a2.id, { takenAt: 1500, totalUsd: 5, balances: [] });
    await snapshotsOf(USER_B).write(b1.id, { takenAt: 1200, totalUsd: 999, balances: [] });

    const totals = await snapshotsOf(USER_A).listTotals();
    expect(totals.map((t) => t.takenAt)).toEqual([1000, 1500, 2000]); // ascending, excludes user B
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
    expect(page2[0]!.accountId).toBe(a.id); // excludes user B

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
