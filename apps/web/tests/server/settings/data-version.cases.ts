import { beforeEach, describe, expect, it } from "vitest";
import { handleGetDataVersion } from "@/lib/server/settings/data-version";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// The browser polls this one number to decide whether to refetch; DB triggers bump it (coverage of
// those lives in @folio/db), this pins the server-fn side.
describe("settings/data-version", () => {
  const USER = "h-set-dv";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  it("new user → 0", async () => {
    expect(await call(USER, handleGetDataVersion())).toEqual({ version: 0 });
  });

  it("changes after a write; stable on re-read", async () => {
    const before = (await call(USER, handleGetDataVersion())).version;
    const acc = await seedAccount(USER, "甲");
    const afterCreate = (await call(USER, handleGetDataVersion())).version;
    expect(afterCreate).toBeGreaterThan(before);

    await db(USER).accounts.rename(acc.id, "乙");
    const afterRename = (await call(USER, handleGetDataVersion())).version;
    expect(afterRename).toBe(afterCreate + 1);
    expect((await call(USER, handleGetDataVersion())).version).toBe(afterRename);
  });

  it("other users' writes don't bump mine", async () => {
    await seedAccount(otherUser(USER), "他们的");
    expect(await call(USER, handleGetDataVersion())).toEqual({ version: 0 });
  });
});
