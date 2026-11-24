import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { provideDbClient } from "../src/client";
import { getDb } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database } from "../src/database";
import { InvalidInput } from "../src/errors";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const tabPinsOf = forDomain((db) => db.tabPins);
const tagsOf = forDomain((db) => db.tags);

const accounts = forDomain((db) => db.accounts);
const portfolios = forDomain((db) => db.portfolios);

// Runs on real D1: tag pin FK cascade, FK-less connector pins surviving, and owner assertions all take effect. Storage isn't isolated per test, so beforeEach resets users.

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

// Runs `create` without flattening failure into a reject: the `forDomain` handle returns a Promise, where die and fail look identical, so inspect the `Exit`.
const createExit = (userId: string, input: Parameters<TabPinCreate>[0]) =>
  Effect.runPromiseExit(
    Effect.flatMap(Database, (db) => db.tabPins.create(input)).pipe(
      Effect.provide(Database.layer),
      provideCurrentUser(userId),
      provideDbClient(env),
    ),
  );

type TabPinCreate = Database["Service"]["tabPins"]["create"];

describe("createTabPin", () => {
  it("creates a connector pin / tag pin, the two columns mutually exclusive", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    const cp = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(cp.connectorId).toBe("binance");
    expect(cp.tagId).toBeNull();
    const tp = await tabPinsOf(USER_A).create({ kind: "tag", tagId: tag.id });
    expect(tp.tagId).toBe(tag.id);
    expect(tp.connectorId).toBeNull();
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
  });

  it("creates an account pin with only account_id set", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    const ap = await tabPinsOf(USER_A).create({ kind: "account", accountId: acc.id });
    expect(ap.accountId).toBe(acc.id);
    expect(ap.tagId).toBeNull();
    expect(ap.connectorId).toBeNull();
  });

  it("a tag pin without tagId / connector pin without connectorId / account pin without accountId is rejected", async () => {
    await portfolios(USER_A).ensureDefault();
    await expect(tabPinsOf(USER_A).create({ kind: "tag" })).rejects.toThrow(
      "tag pin: requires tagId",
    );
    await expect(tabPinsOf(USER_A).create({ kind: "connector" })).rejects.toThrow(
      "connector pin: requires connectorId",
    );
    await expect(tabPinsOf(USER_A).create({ kind: "account" })).rejects.toThrow(
      "account pin: requires accountId",
    );
  });

  // Two kinds of rejection: `Effect.die` is a code bug (endpoint can only 500); `Effect.fail(InvalidInput)` is an invalid combination that can carry a readable message. `rejects.toThrow()` passes for both, so inspect the Cause.
  it("a missing field is a typed failure, not a defect", async () => {
    const exit = await createExit(USER_A, { kind: "tag" });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.findErrorOption(exit.cause).pipe(Option.getOrUndefined)).toBeInstanceOf(
        InvalidInput,
      );
    }
  });

  it("an account pin pointing at another user's account is rejected", async () => {
    await portfolios(USER_B).ensureDefault();
    const accB = await accounts(USER_B).create({ connectorId: "okx", label: "x", creds: "y" });
    await expect(
      tabPinsOf(USER_A).create({ kind: "account", accountId: accB.id }),
    ).rejects.toThrow();
  });

  it("a tag pin pointing at another user's Tag is rejected", async () => {
    const pfB = await portfolios(USER_B).create({ name: "B's" });
    const tagB = await tagsOf(USER_B).create({ portfolioId: pfB.id, name: "x" });
    await expect(tabPinsOf(USER_A).create({ kind: "tag", tagId: tagB.id })).rejects.toThrow();
  });

  // The cap isn't enforced here: it is per portfolio and needs Tag/account ownership, so the app's create handler owns it. This pins that the db doesn't block: a 4th pin still persists.
  it("the db layer ignores the cap: a 4th still persists (the cap is computed per portfolio in the app)", async () => {
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "okx" });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "hyperliquid" });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "manual" });
    expect(await tabPinsOf(USER_A).list()).toHaveLength(4);
  });
});

describe("cascade / survival", () => {
  it("deleting a Tag deletes its tag pin via FK cascade", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    await tabPinsOf(USER_A).create({ kind: "tag", tagId: tag.id });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
    await tagsOf(USER_A).remove(tag.id);
    const left = await tabPinsOf(USER_A).list();
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector"); // only the connector pin is left
  });

  it("deleting an account deletes its account pin via FK cascade; connector pins are unaffected", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await tabPinsOf(USER_A).create({ kind: "account", accountId: acc.id });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    expect(await tabPinsOf(USER_A).list()).toHaveLength(2);
    await accounts(USER_A).remove(acc.id);
    const left = await tabPinsOf(USER_A).list();
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("connector");
  });

  it("a connector pin survives when all accounts under it are deleted (no FK, shown empty)", async () => {
    await portfolios(USER_A).ensureDefault();
    const acc = await accounts(USER_A).create({
      connectorId: "binance",
      label: "B",
      creds: "x",
    });
    await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await accounts(USER_A).remove(acc.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(1); // the pin survives
  });
});

describe("update / reorder / delete + foreign ownership", () => {
  it("updateTabPinTarget changes the target (connector to tag)", async () => {
    const pf = await portfolios(USER_A).ensureDefault();
    const tag = await tagsOf(USER_A).create({ portfolioId: pf.id, name: "Long" });
    const pin = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    await tabPinsOf(USER_A).updateTarget(pin.id, { kind: "tag", tagId: tag.id });
    const [after] = await tabPinsOf(USER_A).list();
    expect(after!.kind).toBe("tag");
    expect(after!.tagId).toBe(tag.id);
    expect(after!.connectorId).toBeNull();
  });

  it("reorderTabPins writes sortOrder in the given order", async () => {
    const a = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    const b = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "okx" });
    await tabPinsOf(USER_A).reorder([b.id, a.id]);
    expect((await tabPinsOf(USER_A).list()).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("deleteTabPin unpins; modifying/deleting another user's pin has no effect", async () => {
    const pin = await tabPinsOf(USER_A).create({ kind: "connector", connectorId: "binance" });
    // B editing A's pin throws.
    await expect(
      tabPinsOf(USER_B).updateTarget(pin.id, { kind: "connector", connectorId: "okx" }),
    ).rejects.toThrow();
    // B deleting A's pin is scoped away: 0 rows affected (no throw), A's pin remains.
    await tabPinsOf(USER_B).remove(pin.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(1);
    // A deleting their own: gone.
    await tabPinsOf(USER_A).remove(pin.id);
    expect(await tabPinsOf(USER_A).list()).toHaveLength(0);
  });
});
