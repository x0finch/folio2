import { beforeEach, describe, expect, it } from "vitest";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · listTags
const USER = "h-tags-list";

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("listTags", () => {
  it("两个 Portfolio 各有 tag → 两个都返回", async () => {
    // **作用域是「谁的」,不是「哪个 Portfolio 的」。** 清单那条写的是「只返回当前作用域该看到的」
    // —— 这个 handler 的作用域就是用户:它调的是 `tags.list()`,按 Portfolio 收窄的是另一个
    // op(`listByPortfolio`),没有 server fn 用。所以断言的是「两个都在」。
    const a = await db(USER).portfolios.ensureDefault();
    const b = await db(USER).portfolios.create({ name: "另一个" });
    await db(USER).tags.create({ portfolioId: a.id, name: "长期" });
    await db(USER).tags.create({ portfolioId: b.id, name: "短线" });

    const tags = await call(USER, handleListTags());

    expect(tags.map((t) => t.name).sort()).toEqual(["短线", "长期"]);
  });

  it("一个 tag 都没有 → 空数组,不是 null", async () => {
    expect(await call(USER, handleListTags())).toEqual([]);
  });

  it("别人的 tag 不会出现在我的清单里", async () => {
    const mine = await db(USER).portfolios.ensureDefault();
    const theirs = await db(otherUser(USER)).portfolios.ensureDefault();
    await db(USER).tags.create({ portfolioId: mine.id, name: "我的" });
    await db(otherUser(USER)).tags.create({ portfolioId: theirs.id, name: "别人的" });

    const tags = await call(USER, handleListTags());

    expect(tags.map((t) => t.name)).toEqual(["我的"]);
  });

  it("tag 所属的 Portfolio 被删掉 → 不返回悬空 tag", async () => {
    const pf = await db(USER).portfolios.create({ name: "要被删的" });
    await db(USER).tags.create({ portfolioId: pf.id, name: "跟着走" });
    await db(USER).portfolios.remove(pf.id);

    expect(await call(USER, handleListTags())).toEqual([]);
  });
});
