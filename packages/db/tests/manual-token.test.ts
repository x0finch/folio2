import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { manualActivity, tokens as tokensTable } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

const manualOf = forDomain((db) => db.manual);

const accounts = forDomain((db) => db.accounts);
const tokensOf = forOracle((db) => db.tokens);

// A manual coin is a row in `tokens` (no manual_token table), so holdings are derived from the tokens in an account's ledger. These tests cover that derivation and the two ownership gates.

const USER_A = "user-a";
const USER_B = "user-b";
const NAMER = "coingecko";

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

async function manualAccount(userId: string) {
  return accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });
}

// Creates a token row for the user (production mints; this file doesn't test recognition). With `coinId`, also links that ref, which a holding's `ref` is read from.
async function mintToken(userId: string, symbol: string, coinId?: string): Promise<string> {
  return tokensOf(userId, NAMER).create({ symbol }, coinId ? [`${NAMER}/issued:${coinId}`] : []);
}

// Same, but the ref's localName is given whole by the caller (to feed non-`issued` shapes).
async function mintTokenWithRef(
  userId: string,
  symbol: string,
  localName: string,
): Promise<string> {
  return tokensOf(userId, NAMER).create({ symbol }, [`${NAMER}/${localName}`]);
}

describe("manual holdings (= tokens rows + ledger)", () => {
  it("which coins are held is derived from the ledger; ref reads the current namer's row", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    const eth = await mintToken(USER_A, "ETH");
    await manualOf(USER_A).setHoldingDef(btc, { symbol: "BTC" });
    await manualOf(USER_A).setHoldingDef(eth, { symbol: "ETH" });
    // BTC opened first, so it comes first (ordered by when holding began).
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "set",
      amount: 1,
      occurredAt: 100,
    });
    await manualOf(USER_A).recordActivity(acc.id, eth, {
      kind: "set",
      amount: 2,
      occurredAt: 200,
    });

    const rows = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    // The whole ref, not the right half: returning only `bitcoin` would make every caller re-add `<namer>/issued:` and so learn the current upstream.
    expect(rows.map((r) => [r.symbol, r.ref])).toEqual([
      ["BTC", `${NAMER}/issued:bitcoin`],
      ["ETH", null], // this namer hasn't recognised it yet
    ]);
  });

  // Whatever the right half's shape, `ref` is returned whole; rejecting typed names as coins is mint's job (`hasTrustedSymbol`).
  it("ref is shape-agnostic: contract addresses and typed names are returned whole too", async () => {
    const acc = await manualAccount(USER_A);
    const onchain = await mintTokenWithRef(USER_A, "SCAM", "contract:0xdead");
    const typed = await mintTokenWithRef(USER_A, "MYCOIN", "custom:MYCOIN");
    for (const [i, id] of [onchain, typed].entries()) {
      await manualOf(USER_A).recordActivity(acc.id, id, {
        kind: "set",
        amount: 1,
        occurredAt: 100 + i,
      });
    }

    const rows = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    expect(rows.map((r) => [r.symbol, r.ref])).toEqual([
      ["SCAM", `${NAMER}/contract:0xdead`],
      ["MYCOIN", `${NAMER}/custom:MYCOIN`],
    ]);
  });

  it("a coin with no activity isn't this account's holding", async () => {
    const acc = await manualAccount(USER_A);
    await mintToken(USER_A, "BTC", "bitcoin"); // the token row exists but this account never touched it
    expect(await manualOf(USER_A).listHoldings(acc.id, NAMER)).toEqual([]);
  });

  // The same coin held by two manual accounts is one tokens row plus two ledgers.
  it("two accounts holding one coin: their amounts don't interfere, they share one token row", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await manualOf(USER_A).recordActivity(a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).recordActivity(a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    // Each sees only its own ledger: activity by token must carry accountId or amounts would mix.
    expect((await manualOf(USER_A).listActivityByToken(a1.id, btc)).map((r) => r.amount)).toEqual([
      1,
    ]);
    expect((await manualOf(USER_A).listActivityByToken(a2.id, btc)).map((r) => r.amount)).toEqual([
      5,
    ]);
    // Both recognise the coin, and it's the same row.
    expect((await manualOf(USER_A).listHoldings(a1.id, NAMER))[0].id).toBe(btc);
    expect((await manualOf(USER_A).listHoldings(a2.id, NAMER))[0].id).toBe(btc);
  });

  it("activity by token: ascending by occurred_at, carrying both (account, token) keys", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "add",
      amount: 5,
      occurredAt: 200,
    });
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "set",
      amount: 10,
      occurredAt: 100,
    });
    const rows = await manualOf(USER_A).listActivityByToken(acc.id, btc);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
    expect(rows.every((r) => r.tokenId === btc && r.accountId === acc.id)).toBe(true);
  });

  // Editing the declaration touches only symbol: name / logo / upstream ref belong to the reference layer, and price comes only from the ledger (`tokens.self_price` has no writer).
  it("editing the declaration changes only symbol: name / logo / upstream ref belong to the reference layer", async () => {
    const acc = await manualAccount(USER_A);
    const foo = await mintToken(USER_A, "FOO", "foo-token");
    await manualOf(USER_A).recordActivity(acc.id, foo, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).setHoldingDef(foo, { symbol: "FOO" });

    const [row] = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    expect([row.symbol, row.ref]).toEqual(["FOO", `${NAMER}/issued:foo-token`]); // ref untouched
  });

  // Clearing a holding deletes this account's activity; the token row stays (it carries the upstream ref / name / logo, and other accounts may use it).
  it("clearing a holding deletes only this account's activity; the token row and other accounts are unaffected", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await manualOf(USER_A).recordActivity(a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).recordActivity(a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    await manualOf(USER_A).detachHolding(a1.id, btc);

    expect(await manualOf(USER_A).listHoldings(a1.id, NAMER)).toEqual([]);
    expect(await manualOf(USER_A).listHoldings(a2.id, NAMER)).toHaveLength(1);
    const rows = await getDb(env).select().from(tokensTable).where(eq(tokensTable.id, btc));
    expect(rows).toHaveLength(1); // the token row is still there
  });
});

describe("ownership: both gates must block", () => {
  it("recording activity on another user's token throws and doesn't attach to their coin", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    const accB = await manualAccount(USER_B);
    // B uses their own account + A's tokenId: the account gate passes, the token gate must block.
    await expect(
      manualOf(USER_B).recordActivity(accB.id, btc, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
    expect(await manualOf(USER_A).listActivityByToken(acc.id, btc)).toEqual([]);
  });

  it("recording activity on another user's account throws", async () => {
    const acc = await manualAccount(USER_A);
    const tokenB = await mintToken(USER_B, "BTC");
    await expect(
      manualOf(USER_B).recordActivity(acc.id, tokenB, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
  });

  it("others can't read, edit or clear it", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await expect(manualOf(USER_B).listHoldings(acc.id, NAMER)).rejects.toThrow();
    await expect(manualOf(USER_B).setHoldingDef(btc, { symbol: "X" })).rejects.toThrow();
    await expect(manualOf(USER_B).detachHolding(acc.id, btc)).rejects.toThrow();
    expect(await manualOf(USER_A).listHoldings(acc.id, NAMER)).toHaveLength(1);
  });

  it("deleting the account cascades its ledger (token rows untouched; that's the reference layer)", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await accounts(USER_A).remove(acc.id);

    const acts = await getDb(env).select().from(manualActivity);
    expect(acts.filter((r) => r.accountId === acc.id)).toEqual([]);
    const rows = await getDb(env).select().from(tokensTable).where(eq(tokensTable.id, btc));
    expect(rows).toHaveLength(1);
  });
});
