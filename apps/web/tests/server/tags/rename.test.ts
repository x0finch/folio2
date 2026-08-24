import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { handleRenameTag, RenameTagInput } from "@/lib/server/tags/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · renameTag
const USER = "h-tags-rename";

const seedTag = async (userId: string, name = "旧名") => {
  const pf = await db(userId).portfolios.ensureDefault();
  return db(userId).tags.create({ portfolioId: pf.id, name });
};

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("renameTag", () => {
  it("改完列表里是新名字", async () => {
    const tag = await seedTag(USER);

    await call(USER, handleRenameTag({ tagId: tag.id, name: "新名" }));

    expect((await call(USER, handleListTags())).map((t) => t.name)).toEqual(["新名"]);
  });

  it("改名不动归属 —— 还在原来那个 Portfolio 下", async () => {
    const tag = await seedTag(USER);

    await call(USER, handleRenameTag({ tagId: tag.id, name: "新名" }));

    expect((await call(USER, handleListTags()))[0].portfolioId).toBe(tag.portfolioId);
  });

  it("改成空串 / 纯空格 → schema 拒", () => {
    expect(RenameTagInput.safeParse({ tagId: "t1", name: "" }).success).toBe(false);
    expect(RenameTagInput.safeParse({ tagId: "t1", name: "  " }).success).toBe(false);
  });

  it("改别人的 tag → 拒,对方那个名字一个字没变", async () => {
    const theirs = await seedTag(otherUser(USER), "他们的");

    const exit = await callExit(USER, handleRenameTag({ tagId: theirs.id, name: "被我改了" }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect((await call(otherUser(USER), handleListTags())).map((t) => t.name)).toEqual(["他们的"]);
  });

  it("改一个不存在的 tagId → 拒", async () => {
    const exit = await callExit(USER, handleRenameTag({ tagId: "没有这个", name: "x" }));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  // 与 createTag 的重名那条同一个待定项:改成一个同 Portfolio 内已存在的名字,现在会成功。
  it.skip("改成已存在的名字 → 待定:随重名规则一并定", () => {});
});
