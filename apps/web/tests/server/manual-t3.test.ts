import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveAmount } from "@/lib/core/manual";
import { NAMER } from "@/lib/server/oracle";
import { dbFor } from "./db-effect";
import {
  addManualActivities,
  createManualAccount,
  createToken,
  deleteToken,
  editManualActivity,
  updateToken,
} from "./manual-fns";
import { ticketOf } from "./ticket";

// Server write-path integration: holding CRUD + batch activities (atomic) + delete/edit activities, all persisted. Real D1 (Miniflare);
// storage not isolated per test, so beforeEach resets. Assertions read holding definitions + ledger fold (compute-on-read).
const USER = "user-manual-t3";
// seedAccount's opening set has occurredAt = Date.now(); later activities must come after it or the set resets the baseline.
// A far-future (still valid epoch-ms) timestamp guarantees the ordering.
const LATER = 4_000_000_000_000;

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

// The account's holdings: definitions + quantities folded from the ledger (compute-on-read).
async function readTokens(accountId: string) {
  const rows = await dbFor(USER).manual.listHoldings(accountId, NAMER);
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      symbol: r.symbol,
      amount: deriveAmount(await dbFor(USER).manual.listActivityByToken(accountId, r.id)),
      ref: r.ref,
    })),
  );
}

// A manual account with a single token (BTC, initial amount 1).
async function seedAccount() {
  const account = await createManualAccount(
    USER,
    "M",
    JSON.stringify([
      { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
    ]),
  );
  return account;
}

describe("createToken", () => {
  it("create token + opening set activity -> token appears, amount === initial", async () => {
    const account = await seedAccount();
    await createToken(USER, {
      accountId: account.id,
      symbol: "ETH",
      unitPrice: 3000,
      amount: 2,
      ticket: ticketOf("ethereum"),
    });
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => [t.symbol, t.amount]).sort()).toEqual([
      ["BTC", 1],
      ["ETH", 2],
    ]);
    expect(tokens.find((t) => t.symbol === "ETH")?.ref).toBe(`${NAMER}/issued:ethereum`);
  });
});

describe("updateToken", () => {
  it("price/identity edits reflect immediately; changing the target amount appends an aligning set, derived === new value", async () => {
    const account = await seedAccount();
    const [btc] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await updateToken(USER, {
      accountId: account.id,
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 65000,
      amount: 3, // from 1 to 3
    });
    const tokens = await readTokens(account.id);
    expect(tokens[0].amount).toBe(3);
    // An aligning set is appended (opening set + aligning set = 2), and the price edit lands on that entry:
    // the ledger is the only source of price, so a price edit needs a place in it.
    const activities = await dbFor(USER).manual.listActivityByToken(account.id, btc.id);
    const sets = activities.filter((a) => a.kind === "set");
    expect(sets).toHaveLength(2);
    expect(sets.at(-1)?.price).toBe(65000);
  });

  it("target amount unchanged -> no activity appended", async () => {
    const account = await seedAccount();
    const [btc] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await updateToken(USER, {
      accountId: account.id,
      tokenId: btc.id,
      symbol: "BTC",
      unitPrice: 61000,
      amount: 1, // unchanged
    });
    expect(await dbFor(USER).manual.listActivityByToken(account.id, btc.id)).toHaveLength(1);
  });
});

describe("deleteToken", () => {
  it("delete token -> gone from holdings (activities cascade)", async () => {
    const account = await seedAccount();
    await createToken(USER, {
      accountId: account.id,
      symbol: "ETH",
      unitPrice: 3000,
      amount: 2,
    });
    const eth = (await dbFor(USER).manual.listHoldings(account.id, NAMER)).find(
      (t) => t.symbol === "ETH",
    );
    if (!eth) throw new Error("eth missing");
    await deleteToken(USER, account.id, eth.id);
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => t.symbol)).toEqual(["BTC"]);
  });
});

describe("addManualActivities", () => {
  it("draft points at an unheld token -> creates the holding + records the activity (atomic)", async () => {
    const account = await seedAccount();
    const res = await addManualActivities(USER, account.id, [
      {
        token: { symbol: "SOL", unitPrice: 150, ticket: ticketOf("solana") },
        kind: "add",
        amount: 10,
        occurredAt: LATER + 2,
      },
    ]);
    expect(res.ok).toBe(true);
    const tokens = await readTokens(account.id);
    expect(tokens.map((t) => t.symbol).sort()).toEqual(["BTC", "SOL"]);
    expect(tokens.find((t) => t.symbol === "SOL")?.amount).toBe(10);
  });

  it("whole batch rejected: any reduce overspending at its point in time -> {ok:false}, nothing written (atomic)", async () => {
    const account = await seedAccount();
    const before = await readTokens(account.id);
    const res = await addManualActivities(USER, account.id, [
      // Existing BTC holding is 1; the batch adds 0.5 to it (valid) + reduces new token DOGE by 100 (baseline 0, overspend).
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 3,
      },
      {
        token: { symbol: "DOGE", unitPrice: 0.1, ticket: ticketOf("dogecoin") },
        kind: "reduce",
        amount: 100,
        occurredAt: LATER + 3,
      },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.symbol).toBe("DOGE");
    // Atomic: BTC unchanged, DOGE not created.
    expect(await readTokens(account.id)).toEqual(before);
    expect((await dbFor(USER).manual.listHoldings(account.id, NAMER)).map((t) => t.symbol)).toEqual(
      ["BTC"],
    );
  });
});

// Ownership negative paths: guards on the new db ops (userId-scoped assert + commitManualBatch's tokenId-in-account check);
// each failed guard throws, so cross-user / cross-account writes are ruled out by API shape.
describe("authorization defense (cross-user / cross-account)", () => {
  const OTHER = "user-manual-t3-other";
  async function ensureOther(): Promise<void> {
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(OTHER).run();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(OTHER, OTHER, `${OTHER}@example.com`, 0, now, now)
      .run();
  }

  it("cross-user edit of a holding -> throws (token ownership check)", async () => {
    await ensureOther();
    const account = await seedAccount(); // owned by USER
    const [btc] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await expect(
      updateToken(OTHER, {
        accountId: account.id,
        tokenId: btc.id,
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      }),
    ).rejects.toThrow();
  });

  it("cross-user clearing of a holding -> throws", async () => {
    await ensureOther();
    const account = await seedAccount();
    const [btc] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await expect(deleteToken(OTHER, account.id, btc.id)).rejects.toThrow();
  });

  it("cross-user adding an activity to someone else's account -> throws (commitManualBatch assertAccountOwned)", async () => {
    await ensureOther();
    const account = await seedAccount();
    await expect(
      addManualActivities(OTHER, account.id, [
        {
          token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
          kind: "add",
          amount: 1,
          occurredAt: LATER + 1,
        },
      ]),
    ).rejects.toThrow();
    // Not written: USER's BTC is still 1 (OTHER's op was stopped at the assert, zero side effects).
    expect((await readTokens(account.id))[0].amount).toBe(1);
  });

  it("cross-user edit of someone else's activity -> throws (getManualActivityOwner)", async () => {
    await ensureOther();
    const account = await seedAccount();
    const set = (await dbFor(USER).manual.listActivityByAccount(account.id))[0];
    await expect(editManualActivity(OTHER, set.id, { amount: 2 })).rejects.toThrow();
  });

  // The guard is "token in own tokens", not "token already in this account": the account-coin relation is
  // carried by activities themselves, so a just-declared holding belongs to no account before its activity is inserted.
  it("two manual accounts of one user can hold the same coin (no per-account guard)", async () => {
    const a = await seedAccount(); // has BTC
    const b = await createManualAccount(
      USER,
      "B",
      JSON.stringify([{ symbol: "ETH", unitPrice: "1", amount: "1" }]),
    );
    const [btcTok] = await dbFor(USER).manual.listHoldings(a.id, NAMER);

    await dbFor(USER).manual.commitBatch({
      accountId: b.id,
      declare: [],
      activities: [{ tokenId: btcTok.id, kind: "add", amount: 1, occurredAt: LATER + 1 }],
    });

    // b now holds it too, quantities independent (a is still 1).
    expect((await readTokens(b.id)).find((t) => t.symbol === "BTC")?.amount).toBe(1);
    expect((await readTokens(a.id))[0].amount).toBe(1);
  });

  it("commitManualBatch rejects referencing someone else's tokenId (defense in depth)", async () => {
    await ensureOther();
    const a = await seedAccount(); // USER's
    const [btcTok] = await dbFor(USER).manual.listHoldings(a.id, NAMER);
    const other = await createManualAccount(
      OTHER,
      "O",
      JSON.stringify([{ symbol: "ETH", unitPrice: "1", amount: "1" }]),
    );
    await expect(
      dbFor(OTHER).manual.commitBatch({
        accountId: other.id,
        declare: [],
        activities: [{ tokenId: btcTok.id, kind: "add", amount: 1, occurredAt: LATER + 1 }],
      }),
    ).rejects.toThrow(/token not owned/);
  });
});
