import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// per-user 设置(#82 估值口径 + FOL-75 隐私开关)。测的是「读带缺省 / upsert 只覆盖给定字段 / 按用户隔离」——
// 落库对不对,跟时序无关,故保持 Promise 形状(见 effect.ts 的判据)。

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

describe("settings get 缺省", () => {
  it("没有行的用户 → self-first + 不隐藏", async () => {
    expect(await settings(USER).get()).toEqual({
      valuationMode: "self-first",
      hideBalances: false,
    });
  });
});

describe("settings update", () => {
  it("开隐私开关 → 读回 true,估值口径保持缺省", async () => {
    await settings(USER).update({ hideBalances: true });

    expect(await settings(USER).get()).toEqual({
      valuationMode: "self-first",
      hideBalances: true,
    });
  });

  it("只覆盖给定字段:先设估值,再单独关隐私,不动估值", async () => {
    await settings(USER).update({ valuationMode: "source-first", hideBalances: true });
    await settings(USER).update({ hideBalances: false });

    expect(await settings(USER).get()).toEqual({
      valuationMode: "source-first",
      hideBalances: false,
    });
  });

  it("再写一次 → 盖掉旧值", async () => {
    await settings(USER).update({ hideBalances: true });
    await settings(USER).update({ hideBalances: false });

    expect((await settings(USER).get()).hideBalances).toBe(false);
  });

  it("按用户隔离 —— 一个人开隐私不影响另一个", async () => {
    await settings(USER).update({ hideBalances: true });

    expect((await settings(OTHER).get()).hideBalances).toBe(false);
  });
});
