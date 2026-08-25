import { Cause, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { AccountTagInput, handleAttachTag } from "@/lib/server/tags/attach";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · attachTag
const USER = "h-tags-attach";

const seed = async (userId: string) => {
  const pf = await db(userId).portfolios.ensureDefault();
  const account = await db(userId).accounts.create({
    connectorId: "manual",
    label: "甲",
    creds: null,
  });
  await db(userId).portfolios.assignAccount(account.id, pf.id);
  const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "长期" });
  return { pf, account, tag };
};

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("attachTag", () => {
  it("挂上 → 关联清单里出现这个账户与这个 tag", async () => {
    const { account, tag } = await seed(USER);

    await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

    expect(await call(USER, handleListAccountTags())).toEqual([
      expect.objectContaining({ accountId: account.id, tagId: tag.id }),
    ]);
  });

  it("挂两个不同的 tag → 两条关联都在", async () => {
    const { pf, account, tag } = await seed(USER);
    const second = await db(USER).tags.create({ portfolioId: pf.id, name: "短线" });

    await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
    await call(USER, handleAttachTag({ accountId: account.id, tagId: second.id }));

    expect(await call(USER, handleListAccountTags())).toHaveLength(2);
  });

  it("重复挂同一个 → 幂等,不出现两条一样的关联", async () => {
    const { account, tag } = await seed(USER);

    await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));
    await call(USER, handleAttachTag({ accountId: account.id, tagId: tag.id }));

    expect(await call(USER, handleListAccountTags())).toHaveLength(1);
  });

  it("账户是别人的 → 拒,对方的关联清单不动", async () => {
    const mine = await seed(USER);
    const theirs = await seed(otherUser(USER));

    const exit = await callExit(
      USER,
      handleAttachTag({ accountId: theirs.account.id, tagId: mine.tag.id }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await call(otherUser(USER), handleListAccountTags())).toEqual([]);
  });

  it("tag 是别人的 → 拒", async () => {
    const mine = await seed(USER);
    const theirs = await seed(otherUser(USER));

    const exit = await callExit(
      USER,
      handleAttachTag({ accountId: mine.account.id, tagId: theirs.tag.id }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await call(USER, handleListAccountTags())).toEqual([]);
  });

  it("账户与 tag 不在同一个 Portfolio → 现在是 defect,不是给用户看的拒", async () => {
    // **这条钉的是现状,而现状本身待定(#527 待定项)。** 这个组合一个普通请求就够得着
    // (前端只要传一对不同 Portfolio 的 id),但库层走的是 `Effect.die` —— 于是用户拿到的是
    // 一坨 Cause,不是「这个 tag 不属于该账户所在的 Portfolio」。
    // 断言 die 是为了让它一旦被改成类型化失败,这条会红、提醒把用例改成断言那句人话。
    const { account } = await seed(USER);
    const another = await db(USER).portfolios.create({ name: "另一个" });
    const foreignTag = await db(USER).tags.create({ portfolioId: another.id, name: "别处的" });

    const exit = await callExit(
      USER,
      handleAttachTag({ accountId: account.id, tagId: foreignTag.id }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(true);
    expect(await call(USER, handleListAccountTags())).toEqual([]);
  });

  it("accountId / tagId 空串 → schema 拒", () => {
    expect(AccountTagInput.safeParse({ accountId: "", tagId: "t" }).success).toBe(false);
    expect(AccountTagInput.safeParse({ accountId: "a", tagId: "" }).success).toBe(false);
  });
});
