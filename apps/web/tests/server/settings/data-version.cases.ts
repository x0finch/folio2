import { beforeEach, describe, expect, it } from "vitest";
import { handleGetDataVersion } from "@/lib/server/settings/data-version";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// FOL-94 · getDataVersion:浏览器只问这一个数决定要不要重拉。号由库里的触发器抬
// (覆盖面在 `@folio/db` 的 data-version.test.ts 数着),这里钉的是 server fn 这一面。
describe("settings/data-version", () => {
  const USER = "h-set-dv";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  it("全新用户 → 0", async () => {
    expect(await call(USER, handleGetDataVersion())).toEqual({ version: 0 });
  });

  it("写了之后变;再读一次不变", async () => {
    const before = (await call(USER, handleGetDataVersion())).version;
    const acc = await seedAccount(USER, "甲");
    const afterCreate = (await call(USER, handleGetDataVersion())).version;
    expect(afterCreate).toBeGreaterThan(before);

    await db(USER).accounts.rename(acc.id, "乙");
    const afterRename = (await call(USER, handleGetDataVersion())).version;
    expect(afterRename).toBe(afterCreate + 1);
    expect((await call(USER, handleGetDataVersion())).version).toBe(afterRename);
  });

  it("别人的写不动我的号", async () => {
    await seedAccount(otherUser(USER), "他们的");
    expect(await call(USER, handleGetDataVersion())).toEqual({ version: 0 });
  });
});
