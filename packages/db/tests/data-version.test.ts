import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { tokens as tokensTable, userDataVersion } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

// Data version: bumps by 1 whenever user-visible data changes, so the browser knows whether to refetch. The migration 0010 triggers bump it, not the ops; so two things are tested: coverage (by sqlite_master, every owner-bearing table has a trigger or a documented exemption) and behaviour (main write ops bump once, reads don't, no cross-user leakage, user deletion isn't blocked).

const dataVersion = forDomain((db) => db.dataVersion);
const accounts = forDomain((db) => db.accounts);
const snapshots = forDomain((db) => db.snapshots);
const tags = forDomain((db) => db.tags);
const tabPins = forDomain((db) => db.tabPins);
const portfolios = forDomain((db) => db.portfolios);
const settings = forDomain((db) => db.settings);
const manual = forDomain((db) => db.manual);
const tokensOf = forOracle((db) => db.tokens);
const pricesOf = forOracle((db) => db.tokenPrices);

const USER_A = "dv-user-a";
const USER_B = "dv-user-b";
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

// Runs a write and returns how much the version rose.
async function bumpOf(userId: string, write: () => Promise<unknown>): Promise<number> {
  const before = await dataVersion(userId).get();
  await write();
  return (await dataVersion(userId).get()) - before;
}

const manualAccount = (userId: string) =>
  accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });

describe("coverage (sqlite_master)", () => {
  // Tables with triggers and which events. Editing this table redefines "what counts as a user-visible write"; check it in review.
  const COVERED: Record<string, string[]> = {
    accounts: ["insert", "update", "delete"],
    portfolios: ["insert", "update", "delete"],
    portfolio_accounts: ["insert", "update", "delete"],
    tags: ["insert", "update", "delete"],
    account_tags: ["insert", "update", "delete"],
    tab_pins: ["insert", "update", "delete"],
    user_settings: ["insert", "update", "delete"],
    manual_activity: ["insert", "update", "delete"],
    // The only snapshot UPDATE prunes old notes, which are off-screen.
    snapshots: ["insert", "delete"],
    // Only when the user-editable three columns really changed (see the migration's WHEN).
    tokens: ["update"],
  };
  // Owner-bearing tables deliberately without triggers (reasons in the schema's `userDataVersion` section).
  const EXEMPT = new Set([
    "snapshot_balances",
    "account_daily_totals",
    "user_cache",
    "token_refs",
    "user_data_version",
    // better-auth tables: sessions / login methods, not dashboard data.
    "session",
    "account",
    "passkey",
  ]);
  const OWNER_COLUMNS = ["user_id", "account_id", "portfolio_id", "snapshot_id", "tag_id"];

  it("the triggers are exactly the COVERED set", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all<{ name: string; tbl_name: string }>();
    const expected = Object.entries(COVERED)
      .flatMap(([table, events]) => events.map((e) => `${table}_data_version_${e}`))
      .sort();
    expect(results.map((r) => r.name)).toEqual(expected);
  });

  it("every owner-bearing table has a decision: a trigger, or the exemption list", async () => {
    // D1 disallows the table-valued function `pragma_table_info(...)`; ask `PRAGMA table_info` per table.
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    const owned: string[] = [];
    for (const { name } of tables) {
      const { results: cols } = await env.DB.prepare(`PRAGMA table_info(\`${name}\`)`).all<{
        name: string;
      }>();
      if (cols.some((c) => OWNER_COLUMNS.includes(c.name))) owned.push(name);
    }
    expect(owned).toContain("accounts"); // the probe itself isn't broken
    expect(owned.filter((t) => !(t in COVERED) && !EXEMPT.has(t))).toEqual([]);
  });
});

describe("behaviour", () => {
  it("never written gives 0", async () => {
    expect(await dataVersion(USER_A).get()).toBe(0);
  });

  it("account create / rename / archive / change creds / delete each bump", async () => {
    let acc: { id: string } | undefined;
    expect(
      await bumpOf(USER_A, async () => {
        acc = await manualAccount(USER_A);
      }),
    ).toBeGreaterThan(0);
    const id = acc!.id;
    expect(await bumpOf(USER_A, () => accounts(USER_A).rename(id, "N"))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).setArchived(id, true))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).setCredentials(id, "{}"))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).remove(id))).toBeGreaterThan(0);
  });

  it("writing a snapshot bumps once regardless of balance rows (balance rows have no trigger)", async () => {
    const acc = await manualAccount(USER_A);
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    const balance = { amount: 1, usdValue: 1, kind: "spot" as const, tokenId };
    expect(
      await bumpOf(USER_A, () =>
        snapshots(USER_A).write(acc.id, {
          takenAt: 10_000,
          totalUsd: 3,
          balances: [balance, balance, balance],
        }),
      ),
    ).toBe(1);
  });

  it("tags / tabs / portfolios / settings / manual activity each bump", async () => {
    const acc = await manualAccount(USER_A);
    const [portfolio] = await portfolios(USER_A).list();
    let tagId = "";
    expect(
      await bumpOf(USER_A, async () => {
        tagId = (await tags(USER_A).create({ portfolioId: portfolio!.id, name: "t" })).id;
      }),
    ).toBe(1);
    expect(await bumpOf(USER_A, () => tags(USER_A).attach(acc.id, tagId))).toBe(1);
    expect(await bumpOf(USER_A, () => tabPins(USER_A).create({ kind: "tag", tagId }))).toBe(1);
    expect(await bumpOf(USER_A, () => portfolios(USER_A).create({ name: "p2" }))).toBe(1);
    expect(await bumpOf(USER_A, () => settings(USER_A).update({ hideBalances: true }))).toBe(1);

    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    expect(
      await bumpOf(USER_A, () =>
        manual(USER_A).recordActivity(acc.id, tokenId, { kind: "set", amount: 1, occurredAt: 1 }),
      ),
    ).toBe(1);
  });

  it("token rows: a user rename bumps; rewriting the same value / price refresh doesn't", async () => {
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    expect(
      await bumpOf(USER_A, () => manual(USER_A).setHoldingDef(tokenId, { symbol: "XBT" })),
    ).toBe(1);
    expect(
      await bumpOf(USER_A, () => manual(USER_A).setHoldingDef(tokenId, { symbol: "XBT" })),
    ).toBe(0);
    expect(
      await bumpOf(USER_A, () =>
        pricesOf(USER_A, NAMER).put([{ tokenId, unitPrice: 42, asOf: 1 }], 60_000),
      ),
    ).toBe(0);
  });

  it("reads don't bump; one user's writes don't bump another's", async () => {
    await manualAccount(USER_A);
    expect(await bumpOf(USER_A, () => accounts(USER_A).list())).toBe(0);
    expect(await dataVersion(USER_B).get()).toBe(0);
  });

  it("deleting a user: cascades aren't blocked by triggers, and the row disappears with it", async () => {
    const acc = await manualAccount(USER_A);
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    await snapshots(USER_A).write(acc.id, {
      takenAt: 10_000,
      totalUsd: 1,
      balances: [{ amount: 1, usdValue: 1, kind: "spot", tokenId }],
    });
    const db = getDb(env);
    await db.delete(user).where(eq(user.id, USER_A));
    expect(
      await db.select().from(userDataVersion).where(eq(userDataVersion.userId, USER_A)),
    ).toEqual([]);
    expect(await db.select().from(tokensTable).where(eq(tokensTable.userId, USER_A))).toEqual([]);
  });
});
