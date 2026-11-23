import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// Reads have defaults, upsert overwrites only the given fields, and users are isolated; persistence only, so Promise-shaped.

const settings = forDomain((db) => db.settings);

const USER = "settings-user";
const OTHER = "settings-other";

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
  await resetUser(USER);
  await resetUser(OTHER);
});

describe("settings get defaults", () => {
  it("a user with no row gets self-first and not hidden", async () => {
    expect(await settings(USER).get()).toEqual({
      valuationMode: "self-first",
      hideBalances: false,
    });
  });
});

describe("settings update", () => {
  it("turning privacy on reads back true; the valuation mode keeps its default", async () => {
    await settings(USER).update({ hideBalances: true });

    expect(await settings(USER).get()).toEqual({
      valuationMode: "self-first",
      hideBalances: true,
    });
  });

  it("overwrites only the given fields: set valuation, then turn privacy off, valuation untouched", async () => {
    await settings(USER).update({ valuationMode: "source-first", hideBalances: true });
    await settings(USER).update({ hideBalances: false });

    expect(await settings(USER).get()).toEqual({
      valuationMode: "source-first",
      hideBalances: false,
    });
  });

  it("isolated per user: one user's privacy or valuation change doesn't affect another", async () => {
    await settings(USER).update({ valuationMode: "source-first", hideBalances: true });

    expect(await settings(OTHER).get()).toEqual({
      valuationMode: "self-first",
      hideBalances: false,
    });
  });
});
