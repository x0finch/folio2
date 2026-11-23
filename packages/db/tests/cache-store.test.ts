import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// Large values must not drop a whole batch: after precompute moved into this table, one key holds a whole overview JSON and a portfolio writes ~10 keys at once. A failed batch is swallowed upstream (returns false), so keys would never fill. `putMany` splits batches by cumulative bytes, and this pins that every key survives.

const cache = forDomain((db) => db.cache);

const USER = "cache-user";
const OTHER = "cache-other";

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

/** A value "as large as an overview"; `kb` is roughly the KB count. */
const blob = (kb: number) => ({
  rows: Array.from({ length: kb * 8 }, (_, i) => ({ i, s: "0123456789abcdef" })),
});

describe("cache putMany", () => {
  it("ten large values written at once: none are lost", async () => {
    // Ten 200KB values ~2MB, far above one batch's byte budget, so they split into several batches.
    const writes = Array.from({ length: 10 }, (_, i) => ({
      key: `big:${i}`,
      value: blob(200),
      ttlMs: 60_000,
    }));

    await cache(USER).putMany(writes);

    const got = await cache(USER).getMany(writes.map((w) => w.key));
    expect(got.size).toBe(10);
    // Spot-check two contents: counting rows alone would miss a half-written value.
    for (const k of ["big:0", "big:9"]) {
      expect((got.get(k)?.value as ReturnType<typeof blob>).rows).toHaveLength(200 * 8);
    }
  });

  it("isolated per user: another user's same-named key isn't readable", async () => {
    await cache(OTHER).putMany([{ key: "mine", value: "theirs", ttlMs: 60_000 }]);

    expect((await cache(USER).getMany(["mine"])).size).toBe(0);
  });
});
