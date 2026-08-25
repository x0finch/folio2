import { Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateTagInput, handleCreateTag } from "@/lib/server/tags/create";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tags/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tags/create", () => {
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

      const exit = await callExit(
        USER,
        handleCreateTag({ portfolioId: theirs.id, name: "偷来的" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await call(otherUser(USER), handleListTags())).toEqual([]);
    });

    it("同一 Portfolio 内重名 → 拒(大小写不敏感),第一条完好", async () => {
      // **盘点时我写错过一次:** 初稿说「规则未定、两条都落」—— 没量就说。实际规则早就定了:
      // 唯一索引 `tags_user_portfolio_name_uidx` 按 lower(name) 拒,`db tags.test.ts` 一直测着。
      // 这条钉的是 handler 那条路也走得到这个拒。
      const pf = await db(USER).portfolios.ensureDefault();
      await call(USER, handleCreateTag({ portfolioId: pf.id, name: "长期" }));

      const exit = await callExit(USER, handleCreateTag({ portfolioId: pf.id, name: "长期" }));
      const upper = await callExit(USER, handleCreateTag({ portfolioId: pf.id, name: "长期 " }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(upper)).toBe(true); // trim 后同名也算重
      expect(await call(USER, handleListTags())).toHaveLength(1);
    });

    it("跨 Portfolio 同名 → 允许,各自独立", async () => {
      const a = await db(USER).portfolios.ensureDefault();
      const b = await db(USER).portfolios.create({ name: "另一个" });

      await call(USER, handleCreateTag({ portfolioId: a.id, name: "长期" }));
      await call(USER, handleCreateTag({ portfolioId: b.id, name: "长期" }));

      expect(await call(USER, handleListTags())).toHaveLength(2);
    });

    it("双击提交两次 → 第二下被重名拒住,不出现两条", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const body = { portfolioId: pf.id, name: "长期" };

      const [a, b] = await Promise.all([
        callExit(USER, handleCreateTag(body)),
        callExit(USER, handleCreateTag(body)),
      ]);

      // 至少一下成功、至多一条落库 —— 并发下两下都成功才是要抓的那种坏。
      expect([a, b].some((e) => e._tag === "Success")).toBe(true);
      expect(await call(USER, handleListTags())).toHaveLength(1);
    });
  });
});
