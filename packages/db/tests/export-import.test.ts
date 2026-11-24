import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { tokenRefs, tokens } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const transferOf = forDomain((db) => db.transfer);

const manualOf = forDomain((db) => db.manual);
const snapshotsOf = forDomain((db) => db.snapshots);

const accounts = forDomain((db) => db.accounts);

// DB support for export/import v3: listTokensForExport (with ref), listManualActivityByUser (flat across accounts), and the find-or-create family (importToken / importAccount / importSnapshot / importManualActivity), each deduping on a natural content key so repeat imports/merges are idempotent. Real D1.

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
  it("exports Tokens with the ref embedded; an empty user gives []", async () => {
    expect(await transferOf(USER_A).listTokensForExport()).toEqual([]);
    const id = await transferOf(USER_A).importToken(
      { symbol: "USDC", name: "USD Coin", logo: "u.png", providerLogo: "p.png", marketCapRank: 7 },
      [USDC_CGK, USDC_ETH],
    );
    const out = await transferOf(USER_A).listTokensForExport();
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

  it("isolated per user", async () => {
    await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    expect(await transferOf(USER_B).listTokensForExport()).toEqual([]);
  });
});

describe("importToken —— find-or-create", () => {
  it("an empty db creates a row and returns the new id", async () => {
    const id = await transferOf(USER_A).importToken({ symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
    ]);
    expect(id).toBeTruthy();
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe("USDC");
  });

  it("an existing ref reuses that row without creating one (the counterpart of remapping into an empty db)", async () => {
    const id1 = await transferOf(USER_A).importToken({ symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
    ]);
    const id2 = await transferOf(USER_A).importToken({ symbol: "USDCdup", name: "dup" }, [
      USDC_CGK,
    ]);
    expect(id2).toBe(id1);
    expect(await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A))).toHaveLength(1);
  });

  it("on reuse, attaches the missing refs to the existing Token", async () => {
    const id1 = await transferOf(USER_A).importToken({ symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
    ]);
    const id2 = await transferOf(USER_A).importToken({ symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
      USDC_ETH,
    ]);
    expect(id2).toBe(id1);
    const refs = await getDb(env).select().from(tokenRefs).where(eq(tokenRefs.tokenId, id1));
    expect(new Set(refs.map(refKey))).toEqual(new Set([refKey(USDC_CGK), refKey(USDC_ETH)]));
  });

  it("a Token with no ref (theoretical edge) still creates a row", async () => {
    const id = await transferOf(USER_A).importToken({ symbol: "FOO", name: "Foo" }, []);
    expect((await getDb(env).select().from(tokens).where(eq(tokens.id, id)))[0]!.symbol).toBe(
      "FOO",
    );
  });
});

describe("importAccount: find-or-create (natural key = connectorId+platform+label+creds)", () => {
  it("importing the same content again reuses it without creating; the created flag is right", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    const a = await transferOf(USER_A).importAccount(input);
    const b = await transferOf(USER_A).importAccount(input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(await accounts(USER_A).list()).toHaveLength(1);
  });

  it("any differing natural-key field makes a new account", async () => {
    const base = { connectorId: "evm" as const, platform: "evm:1", label: "W" };
    await transferOf(USER_A).importAccount({ ...base, creds: JSON.stringify({ address: "0x1" }) });
    await transferOf(USER_A).importAccount({ ...base, creds: JSON.stringify({ address: "0x2" }) }); // different creds
    await transferOf(USER_A).importAccount({
      ...base,
      label: "W2",
      creds: JSON.stringify({ address: "0x1" }),
    }); // different label
    expect(await accounts(USER_A).list()).toHaveLength(3);
  });

  it("on a match where the file says archived and the existing isn't, aligns to archived", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    await transferOf(USER_A).importAccount(input);
    await transferOf(USER_A).importAccount({ ...input, archivedAt: 1700000000000 });
    const acc = (await accounts(USER_A).list())[0]!;
    expect(acc.archivedAt).toBe(1700000000000);
  });

  it("isolated per user: the same content for different users creates separately", async () => {
    const input = {
      connectorId: "evm" as const,
      platform: "evm:1",
      label: "W",
      creds: JSON.stringify({ address: "0xabc" }),
    };
    await transferOf(USER_A).importAccount(input);
    const b = await transferOf(USER_B).importAccount(input);
    expect(b.created).toBe(true);
    expect(await accounts(USER_A).list()).toHaveLength(1);
    expect(await accounts(USER_B).list()).toHaveLength(1);
  });
});

describe("importSnapshot: find-or-create (natural key = account+takenAt)", () => {
  it("importing the same (account, takenAt) again skips the whole snapshot without rewriting", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "evm",
      label: "W",
      creds: "{}",
    });
    const tk = await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const snap = {
      takenAt: 1000,
      totalUsd: 100,
      balances: [{ tokenId: tk, amount: 1, usdValue: 100, kind: "spot" as const }],
    };
    const a = await transferOf(USER_A).importSnapshot(acc.id, snap);
    const b = await transferOf(USER_A).importSnapshot(acc.id, snap);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await snapshotsOf(USER_A).listByAccount(acc.id)).toHaveLength(1);
    // a different takenAt makes a new snapshot
    await transferOf(USER_A).importSnapshot(acc.id, { ...snap, takenAt: 2000 });
    expect(await snapshotsOf(USER_A).listByAccount(acc.id)).toHaveLength(2);
  });
});

describe("importManualActivity: find-or-create (natural key = whole content)", () => {
  it("the same content again is skipped (no doubling by folding); any differing field adds one", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const act = { kind: "add" as const, amount: 1, price: 60000, occurredAt: 1000, createdAt: 5 };
    const a = await transferOf(USER_A).importManualActivity(acc.id, tk, act);
    const b = await transferOf(USER_A).importManualActivity(acc.id, tk, act);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(1);
    // a different amount adds one
    await transferOf(USER_A).importManualActivity(acc.id, tk, { ...act, amount: 2 });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });

  it("null and set price/fee/memo are told apart correctly (isNull branch)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const base = { kind: "add" as const, amount: 1, occurredAt: 1000 };
    await transferOf(USER_A).importManualActivity(acc.id, tk, base); // price/fee/memo all null
    const dup = await transferOf(USER_A).importManualActivity(acc.id, tk, base);
    expect(dup.created).toBe(false); // null content also hits
    const withPrice = await transferOf(USER_A).importManualActivity(acc.id, tk, {
      ...base,
      price: 1,
    });
    expect(withPrice.created).toBe(true); // null vs set: different
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });

  it("two entries identical except createdAt are different events, both kept (createdAt is in the key so folding can't lose amounts)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    const base = { kind: "add" as const, amount: 1, price: 60000, occurredAt: 1000 };
    const a = await transferOf(USER_A).importManualActivity(acc.id, tk, { ...base, createdAt: 5 });
    const b = await transferOf(USER_A).importManualActivity(acc.id, tk, { ...base, createdAt: 9 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // different createdAt: no folding
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
    // Importing the same two again: both hit, nothing added (idempotent).
    await transferOf(USER_A).importManualActivity(acc.id, tk, { ...base, createdAt: 5 });
    await transferOf(USER_A).importManualActivity(acc.id, tk, { ...base, createdAt: 9 });
    expect(await manualOf(USER_A).listActivityByAccount(acc.id)).toHaveLength(2);
  });
});

describe("listManualActivityByUser", () => {
  it("flat across accounts, ordered by occurred then created ascending, createdAt kept, isolated per user", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await transferOf(USER_A).importToken({ symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
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
    expect(out.map((a) => a.amount)).toEqual([1, 2]); // ascending
    expect(out[0]).toMatchObject({ accountId: acc.id, tokenId: tk, createdAt: 5 }); // createdAt kept
    expect(await manualOf(USER_B).listAllActivity()).toEqual([]);
  });
});
