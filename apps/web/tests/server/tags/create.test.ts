import { Cause, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateTagInput, handleCreateTag } from "@/lib/server/tags/create";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · createTag
const USER = "h-tags-create";

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("createTag", () => {
  it("建一个 → 出现在列表里,归在指定 Portfolio 下", async () => {
    const pf = await db(USER).portfolios.ensureDefault();

    const tag = await call(USER, handleCreateTag({ portfolioId: pf.id, name: "长期" }));

    expect(tag.name).toBe("长期");
    expect(tag.portfolioId).toBe(pf.id);
    expect(await call(USER, handleListTags())).toHaveLength(1);
  });

  it("名字两头带空格 → trim 之后才进 handler", () => {
    // **trim 在入参 schema 上,不在 handler 里。** 所以这条断言的是 schema —— 从 handler 进
    // 是测不到的(它拿到的已经是 trim 过的值)。清单里凡是「脏入参」那一类都落在这一层。
    expect(CreateTagInput.parse({ portfolioId: "p1", name: "  长期  " }).name).toBe("长期");
  });

  it("名字是空串 / 纯空格 → schema 拒", () => {
    expect(CreateTagInput.safeParse({ portfolioId: "p1", name: "" }).success).toBe(false);
    expect(CreateTagInput.safeParse({ portfolioId: "p1", name: "   " }).success).toBe(false);
  });

  it("portfolioId 是别人的 → 拒,不许把 tag 建到别人名下", async () => {
    const theirs = await db(otherUser(USER)).portfolios.ensureDefault();

    const exit = await callExit(USER, handleCreateTag({ portfolioId: theirs.id, name: "偷来的" }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await call(otherUser(USER), handleListTags())).toEqual([]);
  });

  it("portfolioId 压根不存在 → 拒", async () => {
    const exit = await callExit(USER, handleCreateTag({ portfolioId: "没有这个", name: "x" }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isDie(exit.cause)).toBe(false); // 是给用户看的失败,不是 defect
  });

  // **规则未定,故挂起(#527 待定项)。** 同一个 Portfolio 里建两个同名 tag,现在两条都会落库、
  // 各自独立 id。这可能正是想要的(tag 只是软标签),也可能是漏了唯一约束 —— 界面上会出现两个
  // 一模一样的徽章,而用户无从分辨。任何一种断言都是替你拍板,所以先不写。
  it.skip("同一 Portfolio 内重名 → 待定:允许还是拒", () => {});

  // 同上。双击提交的结果完全取决于重名规则,规则定了这条才有唯一答案。
  it.skip("双击提交两次 → 待定:随重名规则一并定", () => {});
});
