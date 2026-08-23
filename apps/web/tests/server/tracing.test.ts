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
    expect(tree.split("\n")[0]).toMatch(/^createTabPin \d+\.\d+ms$/);
  });

  // **两层就够了,这是量出来的**(#504 T16 那张票要的那次实测)。
  //
  // 只有 handler 一层时,`getPortfolioOverview` 的树就一行 `20.0ms` —— 答得了「哪个端点慢」,
  // 答不了「慢在哪」。给 `DbClient` 那一处收口点加上 span 之后,同一棵树是:
  //
  //     getPortfolioOverview 20.0ms
  //       db.query 13.0ms   ← 两条并发的重读,那 20ms 里的大头
  //       db.query 13.0ms
  //       db.query 1.0ms    ← 其余七条各 1–2ms
  //       …
  //
  // 问题就此答完,而**代价是零个方法被改**:七十个 op 全在那条桥上过。要再细就得给它们各起
  // 名字,判据(见那张票)是不值。
  //
  // 这条钉的是**两层都在**:handler 名 + 底下那次 `db.query`。
  it("树有两层:handler 名 + 底下那次 D1", async () => {
    const tree = await treeOf(
      forUser(
        USER,
        Effect.flatMap(Database, (db) => db.tabPins.list()),
      ).pipe(Effect.orDie, Effect.withSpan("listTabPins")),
    );
    const lines = tree.split("\n");
    expect(lines[0]).toMatch(/^listTabPins \d/);
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^ {2}db\.query \d/)]);
  });
});
