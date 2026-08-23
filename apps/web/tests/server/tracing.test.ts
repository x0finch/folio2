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
  it("一次请求一棵树,根是 handler 的名字 + 时长 + 这次是谁", async () => {
    const tree = await treeOf(
      forUser(USER, handleCreateTabPin({ kind: "connector", connectorId: "binance" })).pipe(
        Effect.orDie,
      ),
    );
    // `runEffect` / `forUser` 那句 `Effect.annotateSpans({ userId })` 是 T6 就写下的,
    // 当时落在 no-op tracer 上。这条钉的是它**真的到了树上** —— 不然那句注解是句空话。
    expect(tree.split("\n")[0]).toMatch(/^createTabPin \d+\.\d+ms userId=user-tracing$/);
  });

  // **三层:handler → domain op → D1**(#504 T16)。
  //
  // 只有 handler 一层时,`getPortfolioOverview` 的树就一行 —— 答得了「哪个端点慢」,答不了
  // 「慢在哪」。`DbClient` 那一处收口点给出最里那层,`Database` 聚合出口的 `tracedStores`
  // 给出中间那层「哪个 domain 方法」。同一次请求实测(测试库、数据少,毫秒数只看相对):
  //
  //     getPortfolioOverview 36.0ms userId=user-probe
  //       portfolios.list 11.0ms
  //         db.query 11.0ms
  //       portfolios.ensureDefault 11.0ms
  //         db.query 11.0ms
  //       accounts.list 4.0ms
  //         db.query 4.0ms
  //       …
  //       manual.listActivityByAccount 2.0ms
  //         db.query 2.0ms
  //         db.query 1.0ms   ← 一个 domain 方法发两条查询,只有中间那层看得出来
  //       db.query 2.0ms     ← 没有 domain 名字的那几条是参考层的 store:它们不过 `Database`
  //       db.query 3.0ms        聚合、直接用 `DbClient`,所以只到桥这一层
  //
  // **代价是零个方法被改**:七十个 op 在聚合出口一并包上,桥那头一并包上。
  //
  // 这条钉的是三层都在:handler 名 → `tabPins.list` → `db.query`。
  it("树有三层:handler 名 → domain op → D1", async () => {
    const tree = await treeOf(
      forUser(
        USER,
        Effect.flatMap(Database, (db) => db.tabPins.list()),
      ).pipe(Effect.orDie, Effect.withSpan("listTabPins")),
    );
    const lines = tree.split("\n");
    expect(lines[0]).toMatch(/^listTabPins \d/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^ {2}tabPins\.list \d/),
      expect.stringMatching(/^ {4}db\.query \d/),
    ]);
  });
});
