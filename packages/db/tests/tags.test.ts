import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const tagsOf = forDomain((db) => db.tags);

const accounts = forDomain((db) => db.accounts);
const portfolios = forDomain((db) => db.portfolios);

// Runs on real D1: the expression unique index, cascades, and clearing tags in the same batch all take effect. Storage isn't isolated per test, so beforeEach resets users.

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

async function makeAccount(userId: string, label = "A") {
  return accounts(userId).create({ connectorId: "manual", label, creds: "x" });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

describe("createTag / list", () => {
  it("creates a Tag under the given Portfolio, name trimmed on save", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "  Long  " });
    expect(tag.name).toBe("Long");
    expect(tag.portfolioId).toBe(pf.id);
    expect(await tagsOf(USER_A).listByPortfolio(pf.id)).toHaveLength(1);
    expect(await tagsOf(USER_A).list()).toHaveLength(1);
  });

  it("an empty (or whitespace-only) name is rejected", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: "   " })).rejects.toThrow();
  });

  it("creating a Tag in another user's Portfolio is rejected (assertPortfolioOwned)", async () => {
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    await expect(tagsOf(USER_A).create({ portfolioId: pfB.id, name: "x" })).rejects.toThrow();
  });
});

// Name collisions and attaching to another Portfolio's tag are typed failures, not defects, so these assert the readable message, not just "threw something".
describe("names unique within a Portfolio (ignoring case/spaces)", () => {
  it("a duplicate name (after trim) is rejected", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: " Long " })).rejects.toThrow(
      /name already used/,
    );
  });

  it("a case-only difference also counts as a duplicate", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Defi" });
    await expect(tagsOf(USER_A).create({ portfolioId: pf.id, name: "DEFI" })).rejects.toThrow(
      /name already used/,
    );
  });

  it("the same name across Portfolios is allowed", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await tagsOf(USER_A).create({ portfolioId: def.id, name: "Long" });
    await tagsOf(USER_A).create({ portfolioId: watch.id, name: "Long" });
    expect(await tagsOf(USER_A).list()).toHaveLength(2);
  });

  it("the expression unique index is the backstop: inserting a case variant directly hits tags_user_portfolio_name_uidx", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "abc" });
    await expect(
      env.DB.prepare(
        "INSERT INTO tags (id, user_id, portfolio_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, 0, 0)",
      )
        .bind("dup-tag", USER_A, pf.id, "ABC")
        .run(),
    ).rejects.toThrow();
  });
});

describe("renameTag", () => {
  it("rename succeeds; renaming to an existing alias in the same Portfolio is rejected", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const a = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Short" });
    await tagsOf(USER_A).rename(a.id, "Mid");
    expect((await tagsOf(USER_A).list()).map((t) => t.name).sort()).toEqual(["Mid", "Short"]);
    await expect(tagsOf(USER_A).rename(a.id, "Short")).rejects.toThrow(/name already used/);
  });

  it("renaming to one's own current name (case change only) is allowed (self excluded)", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const a = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "defi" });
    await tagsOf(USER_A).rename(a.id, "DeFi");
    expect((await tagsOf(USER_A).list())[0]!.name).toBe("DeFi");
  });
});

describe("attach / detach", () => {
  it("attach / detach; attach is idempotent", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    await tagsOf(USER_A).attach(acc.id, tag.id); // idempotent
    expect(await tagsOf(USER_A).listAccountLinks()).toEqual([{ accountId: acc.id, tagId: tag.id }]);
    await tagsOf(USER_A).detach(acc.id, tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
  });

  it("attaching a Tag from a different Portfolio than the account's is rejected", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A); // lands in the default Portfolio
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    const tag = await tagsOf(USER_A).create({ portfolioId: watch.id, name: "Long" });
    await expect(tagsOf(USER_A).attach(acc.id, tag.id)).rejects.toThrow(/different portfolios/);
  });

  it("foreign ownership: touching another user's account / Tag is rejected", async () => {
    const pfA = await portfolios(USER_A).ensureDefault();
    const accA = await makeAccount(USER_A);
    const tagA = await tagsOf(USER_A).create({ portfolioId: pfA.id, name: "Long" });
    await expect(tagsOf(USER_B).attach(accA.id, tagA.id)).rejects.toThrow();
  });
});

describe("cascade / move clearing", () => {
  it("deleting a Tag clears its account_tags rows via cascade", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(1);
    await tagsOf(USER_A).remove(tag.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
    expect(await tagsOf(USER_A).list()).toHaveLength(0);
  });

  it("deleting an account clears its account_tags rows via cascade", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    await accounts(USER_A).remove(acc.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0);
    expect(await tagsOf(USER_A).list()).toHaveLength(1); // the Tag itself remains
  });

  it("moving an account to another Portfolio clears its Tags (ADR 0034 invariant)", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: def.id, name: "Long" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    const watch = await portfolios(USER_A).create({ name: "Watch" });
    await portfolios(USER_A).assignAccount(acc.id, watch.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(0); // cleared by the move
    expect(await tagsOf(USER_A).list()).toHaveLength(1); // the Tag stays in its original Portfolio
  });

  it("re-pointing at the **current** Portfolio (no real move) keeps Tags, no false clear", async () => {
    const def = await portfolios(USER_A).ensureDefault();
    const acc = await makeAccount(USER_A);
    const tag = await tagsOf(USER_A).create({ portfolioId: def.id, name: "Long" });
    await tagsOf(USER_A).attach(acc.id, tag.id);
    // Target == current: no-op, must not trigger "move clears Tags".
    await portfolios(USER_A).assignAccount(acc.id, def.id);
    expect(await tagsOf(USER_A).listAccountLinks()).toHaveLength(1);
  });
});

describe("cross-user isolation", () => {
  it("listTagsByUser / listAccountTagsByUser return only the caller's", async () => {
    const pfA = await portfolios(USER_A).ensureDefault();
    const pfB = await portfolios(USER_B).ensureDefault();
    const accA = await makeAccount(USER_A);
    const tagA = await tagsOf(USER_A).create({ portfolioId: pfA.id, name: "Long" });
    await tagsOf(USER_A).attach(accA.id, tagA.id);
    await tagsOf(USER_B).create({ portfolioId: pfB.id, name: "Long" });
    expect(await tagsOf(USER_A).list()).toHaveLength(1);
    expect(await tagsOf(USER_B).list()).toHaveLength(1);
    expect(await tagsOf(USER_B).listAccountLinks()).toHaveLength(0);
  });
});
