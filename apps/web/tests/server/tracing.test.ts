import { env } from "cloudflare:test";
import { Database } from "@folio/db";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { forUser } from "@/lib/server/runtime";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { spanTracerTo } from "@/lib/server/tracing";

// span 树(#504 T16)。**驱动真链路**(真 D1 + 生产那条装配),不是喂几个假 span —— 要回答的
// 问题是「一次真请求的树长什么样、够不够用」,那只有真跑一遍才看得出来。
//
// 断言**不看毫秒数**(墙钟,CODING.md 明令别赌),只看树的形状。

const USER = "user-tracing";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

const treeOf = async <A>(effect: Effect.Effect<A, never, never>): Promise<string> => {
  const trees: string[] = [];
  await Effect.runPromise(effect.pipe(Effect.provide(spanTracerTo((t) => trees.push(t)))));
  expect(trees).toHaveLength(1); // 一次请求恰好一棵,不多不少
  return trees[0];
};

describe("span 树", () => {
  it("一次请求一棵树,根是 handler 的名字 + 时长", async () => {
    const tree = await treeOf(
      forUser(USER, handleCreateTabPin({ kind: "connector", connectorId: "binance" })).pipe(
        Effect.orDie,
      ),
    );
    expect(tree).toMatch(/^createTabPin \d+\.\d+ms$/);
  });

  // **handler 级 span 够不够?** 把答案写进代码,而不是留在某个人的印象里。
  //
  // 树里**只有一行**:handler 自己。它答得了「这个请求花了多久」,答不了「里头三次 D1 查询
  // 各占多少」—— 因为 db 那七十个方法没有名字(有意的,判据见 #504 T16 那张票:桥不撒在每个
  // 方法里,要加可观测性该动 `DbClient.query` 那一处收口点)。
  //
  // 这条**故意断言「只有一行」**:哪天有人给 db 那层加了 span,它会红,而那正是该重读那张票的时候。
  it("树里只有 handler 一层 —— db 那几次查询各花多久看不见", async () => {
    const tree = await treeOf(
      forUser(
        USER,
        Effect.flatMap(Database, (db) => db.tabPins.list()),
      ).pipe(Effect.orDie, Effect.withSpan("listTabPins")),
    );
    expect(tree.split("\n")).toHaveLength(1);
    expect(tree).toContain("listTabPins");
  });
});
