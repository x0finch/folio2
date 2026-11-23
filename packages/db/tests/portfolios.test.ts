import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const transferOf = forDomain((db) => db.transfer);

const accounts = forDomain((db) => db.accounts);
const portfolios = forDomain((db) => db.portfolios);

// Runs on real D1: unique constraints, partial indexes, cascades and batches all take effect. Storage isn't isolated per test, so beforeEach resets users (cascade clears portfolios/portfolio_accounts).

const USER_A = "user-a";
const USER_B = "user-b";

async function resetUser(userId: string, name = userId): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name,
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

describe("ensureDefaultPortfolio", () => {
  it("find-or-create: repeated calls for one user return the same row (idempotent)", async () => {
    const p1 = await portfolios(USER_A).ensureDefault();
    const p2 = await portfolios(USER_A).ensureDefault();
    expect(p2.id).toBe(p1.id);
    expect(p1.isDefault).toBe(true);
    expect(await portfolios(USER_A).list()).toHaveLength(1);
  });

  it("name = `<username>'s`", async () => {
    await resetUser(USER_A, "Alice");
    const p = await portfolios(USER_A).ensureDefault();
    expect(p.name).toBe("Alice's");
  });

  it("an empty username falls back to `My Portfolio`", async () => {
    await resetUser(USER_A, "");
    const p = await portfolios(USER_A).ensureDefault();
    expect(p.name).toBe("My Portfolio");
  });

  it("partial unique index: one user can have only one default Portfolio", async () => {
    const p = await portfolios(USER_A).ensureDefault();
    // Manually inserting a second default hits portfolios_user_default_uidx.
    await expect(
      env.DB.prepare(
        "INSERT INTO portfolios (id, user_id, name, is_default, sort_order, created_at) VALUES (?, ?, ?, 1, 0, 0)",
      )
        .bind("dup-pf", USER_A, "Dup")
        .run(),
    ).rejects.toThrow();
    expect(p.isDefault).toBe(true);
  });
});

describe("account to portfolio membership (exactly one row per account)", () => {
  it("createAccount puts the new account in the default Portfolio", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pf = await portfolios(USER_A).ensureDefault();
    const memberships = await portfolios(USER_A).listMemberships();
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: pf.id }]);
  });

  it("accounts.listWithPortfolio: one query gives account + membership (no membership row gives null, own accounts only)", async () => {
    const acc = await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    const loose = await accounts(USER_A).create({ connectorId: "manual", label: "L", creds: "x" });
    await accounts(USER_B).create({ connectorId: "manual", label: "B", creds: "x" });
    const pf = await portfolios(USER_A).ensureDefault();
    await env.DB.prepare("DELETE FROM portfolio_accounts WHERE account_id = ?")
      .bind(loose.id)
      .run();

    const rows = await accounts(USER_A).listWithPortfolio();
    expect(rows.map((r) => [r.id, r.portfolioId]).sort()).toEqual(
      [
        [acc.id, pf.id],
        [loose.id, null],
      ].sort(),
    );
    // Safe columns: no creds.
    expect(rows.every((r) => !("creds" in r))).toBe(true);
  });

  it("importAccount (new branch) also joins the default Portfolio", async () => {
    const { id, created } = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Imported",
      creds: "x",
    });
    expect(created).toBe(true);
    const pf = await portfolios(USER_A).ensureDefault();
    expect(await portfolios(USER_A).listMemberships()).toEqual([
      { accountId: id, portfolioId: pf.id },
    ]);
  });

  it("importAccount (existing match) doesn't insert membership again", async () => {
    const first = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    const second = await transferOf(USER_A).importAccount({
      connectorId: "manual",
      label: "Dup",
      creds: "x",
    });
    expect(second.id).toBe(first.id);
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
  });

  it("deleting an account clears its membership row via cascade", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
    await accounts(USER_A).remove(acc.id);
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(0);
    expect(await accounts(USER_A).list()).toHaveLength(0);
  });

  it("one-to-one lock: an account can't belong to two Portfolios", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    // Manually inserting another membership (different portfolio_id) hits portfolio_accounts_account_uidx.
    await expect(
      env.DB.prepare("INSERT INTO portfolio_accounts (portfolio_id, account_id) VALUES (?, ?)")
        .bind("other-pf", acc.id)
        .run(),
    ).rejects.toThrow();
  });
});

describe("createPortfolio / assignAccountToPortfolio", () => {
  it("createPortfolio makes a named non-default Portfolio; the list is in creation order (default not pinned first)", async () => {
    const def = await portfolios(USER_A).ensureDefault(); // create the default first
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    expect(watch.isDefault).toBe(false);
    const all = await portfolios(USER_A).list();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id)).toEqual([def.id, watch.id]); // creation order: default was created first, so it's first (not because it's default)
    expect(all.filter((p) => p.isDefault)).toHaveLength(1); // still exactly one default
  });

  it("assignAccountToPortfolio changes membership one-to-one (replaces the old row, doesn't stack)", async () => {
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);
    const memberships = await portfolios(USER_A).listMemberships();
    expect(memberships).toEqual([{ accountId: acc.id, portfolioId: watch.id }]); // still exactly one row, pointing at Watch
  });

  it("assignAccountToPortfolio rejects foreign ownership (another user's account / Portfolio)", async () => {
    const accA = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    // Moving A's account into B's Portfolio is rejected.
    await expect(portfolios(USER_A).assignAccount(accA.id, pfB.id)).rejects.toThrow();
    // B moving A's account is rejected (account owner assertion).
    await expect(portfolios(USER_B).assignAccount(accA.id, pfB.id)).rejects.toThrow();
  });
});

describe("management: rename / setDefault / delete", () => {
  it("renamePortfolio renames (including the default)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    await portfolios(USER_A).rename(def.id, "Renamed");
    const all = await portfolios(USER_A).list();
    expect(all[0]!.name).toBe("Renamed");
  });

  it("setDefaultPortfolio switches the default: exactly one default, the old one demoted", async () => {
    const old = await portfolios(USER_A).ensureDefault();
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).setDefault(watch.id);
    const all = await portfolios(USER_A).list();
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
    expect(all.find((p) => p.id === watch.id)!.isDefault).toBe(true);
    expect(all.find((p) => p.id === old.id)!.isDefault).toBe(false);
  });

  it("deletePortfolio refuses to delete the default", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    // A typed failure, not a defect: a stale page can send this request.
    await expect(portfolios(USER_A).remove(def.id)).rejects.toThrow(
      /default portfolio cannot be deleted/,
    );
  });

  it("deletePortfolio on a named group: members return to the default, then the row is deleted (accounts untouched)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "manual",
      label: "A",
      creds: "x",
    });
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);

    await portfolios(USER_A).remove(watch.id);

    // The group is gone, the account remains, membership returns to the default.
    expect(await portfolios(USER_A).list()).toHaveLength(1);
    expect(await accounts(USER_A).list()).toHaveLength(1);
    expect(await portfolios(USER_A).listMemberships()).toEqual([
      { accountId: acc.id, portfolioId: def.id },
    ]);
  });

  it("an empty named group can also be deleted (empty groups persist and are only deleted explicitly)", async () => {
    await portfolios(USER_A).ensureDefault();
    const empty = await portfolios(USER_A).create({ name: "Empty" });
    await portfolios(USER_A).remove(empty.id);
    expect(await portfolios(USER_A).list()).toHaveLength(1);
  });
});

describe("listPortfolios / memberships isolated across users", () => {
  it("listPortfoliosByUser returns only the caller's", async () => {
    await portfolios(USER_A).ensureDefault();
    await portfolios(USER_B).ensureDefault();
    const a = await portfolios(USER_A).list();
    expect(a).toHaveLength(1);
    expect(a[0]!.isDefault).toBe(true);
    expect(await portfolios(USER_B).list()).toHaveLength(1);
  });

  it("memberships don't leak other users' account membership", async () => {
    await accounts(USER_A).create({ connectorId: "manual", label: "A", creds: "x" });
    await accounts(USER_B).create({ connectorId: "manual", label: "B", creds: "x" });
    expect(await portfolios(USER_A).listMemberships()).toHaveLength(1);
    expect(await portfolios(USER_B).listMemberships()).toHaveLength(1);
    const aAccts = new Set((await accounts(USER_A).list()).map((x) => x.id));
    for (const m of await portfolios(USER_A).listMemberships()) {
      expect(aAccts.has(m.accountId)).toBe(true);
    }
  });
});

// Names are unique (same as tags): the index guards concurrency, the domain gives a readable message first.
describe("names unique per user", () => {
  it("a duplicate name is rejected; differing only in case/spaces counts as a duplicate", async () => {
    await portfolios(USER_A).ensureDefault();
    await portfolios(USER_A).create({ name: "Long-term" });
    await expect(portfolios(USER_A).create({ name: "Long-term" })).rejects.toThrow(
      /name already used/,
    );
    // Edge spaces count as the same name, otherwise "Long-term" and "Long-term " look identical on screen yet are two rows.
    await expect(portfolios(USER_A).create({ name: "Long-term " })).rejects.toThrow(
      /name already used/,
    );
    await expect(portfolios(USER_A).create({ name: "Defi" })).resolves.toBeTruthy();
    await expect(portfolios(USER_A).create({ name: "DEFI" })).rejects.toThrow(/name already used/);
  });

  it("uniqueness is per user: another user's same name doesn't block me", async () => {
    await portfolios(USER_A).create({ name: "Long-term" });
    await expect(portfolios(USER_B).create({ name: "Long-term" })).resolves.toBeTruthy();
  });

  it("a rename that collides is rejected; renaming to one's own current name (spaces only) is allowed, trimmed on save", async () => {
    await portfolios(USER_A).ensureDefault();
    const a = await portfolios(USER_A).create({ name: "Long-term" });
    await portfolios(USER_A).create({ name: "Short-term" });
    await expect(portfolios(USER_A).rename(a.id, "Short-term")).rejects.toThrow(
      /name already used/,
    );
    await portfolios(USER_A).rename(a.id, " Long-term ");
    expect((await portfolios(USER_A).list()).map((p) => p.name)).toContain("Long-term");
  });

  it("the default's name being taken still creates it: first app open must not die", async () => {
    // Rare but reachable: a named Portfolio is literally called `<username>'s`, and this user has no default row yet.
    // The default name isn't typed by the user, so there's no "pick another"; it finds a free name itself.
    await portfolios(USER_A).create({ name: `${USER_A}'s` });
    const def = await portfolios(USER_A).ensureDefault();
    expect(def.isDefault).toBe(true);
    expect(def.name).toBe(`${USER_A}'s (2)`);
  });
});
