import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Effect } from "effect";
import { connectTo, DbClient } from "./client";
import type { Drizzle } from "./connect";

// **D1 绑定之外的第二种连接:一条「给我 SQL + 参数,我还你行」的代理**(FOL-85)。
//
// 为什么要它:刷全局映射表挪出了 Worker(免费计划一次调用 10ms CPU,那一趟要 ~400ms),改由
// GitHub Actions 里的 Node 脚本跑(`apps/web/scripts/ref-index/`)。Node 里没有 D1 绑定,只有
// Cloudflare 的 D1 REST API(或本机 Miniflare 那个 SQLite 文件)。**差量算法、分批规则、护栏一行都
// 不该在脚本里再写一遍** —— 它们就是 `domains/global-ref-index.ts` 的 `putAll`。所以脚本给的是
// 一个传输层,这里把它接成同一个 `DbClient`,上面的门票(`GlobalDatabase`)原样可用。
//
// **出包的只有「给」的组合子**,与 `provideDbClient(env)` 同一个形状、同一条红线(原则 #6):
// 调用方交进来的是传输(`RemoteSql`),拿不回 drizzle 句柄,也拿不到 `DbClient` 的值。
//
// drizzle 的 `sqlite-proxy` 驱动就是为「远端执行 SQL」设计的:它负责拼 SQL / 绑参数 / 把数组行
// 映射回字段,传输只管往返。

/** drizzle 对每条语句要的形状:`all`/`values` 多行、`get` 一行、`run` 不看结果。 */
export type RemoteMethod = "run" | "all" | "values" | "get";

export interface RemoteStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: RemoteMethod;
}

/**
 * 传输层的契约。行一律是**值数组**(列按 SELECT 的顺序),不是对象 —— D1 REST 的 `/raw` 与
 * `node:sqlite` 的 `setReturnArrays` 给的都是这个形状,drizzle 按位置映射回字段(同名列也不会互相覆盖)。
 * 失败就 reject:这一层把它当 defect(与 D1 绑定那条路一致,见 client.ts「错误通道是 never」)。
 */
export interface RemoteSql {
  query(stmt: RemoteStatement): Promise<unknown[][]>;
  /** 一批语句,**一个事务、按序执行**(D1 batch 的语义);结果与语句一一对应。 */
  batch(stmts: readonly RemoteStatement[]): Promise<unknown[][][]>;
}

// drizzle 的 `get` 要的是「那一行」(没有 → undefined),其余要行数组。批里批外同一个规矩。
const shape = (method: RemoteMethod, rows: unknown[][]) => ({
  rows: method === "get" ? rows[0] : rows,
});

// **类型上的一处让步**:`Drizzle` 是 D1 驱动的句柄类型,代理驱动的句柄与它同属 `BaseSQLiteDatabase
// <"async">`,查询构造器、`batch` 完全同形;唯一不同是 `.run()` 的原始返回(D1 带 `meta`,代理只有
// `rows`)。全包没有一处读 `.run()` 的返回(`meta` / `changes`),所以按 D1 的类型用它是安全的。
const proxyDrizzle = (remote: RemoteSql): Drizzle =>
  drizzle(
    async (sql, params, method) => shape(method, await remote.query({ sql, params, method })),
    async (stmts) => {
      const results = await remote.batch(stmts);
      return stmts.map((s, i) => shape(s.method, results[i] ?? []));
    },
  ) as unknown as Drizzle;

/**
 * 在一条远端 SQL 传输上跑一段碰 db 的 effect(Node 里的定时任务用)。与 `provideDbClient(env)` 同形:
 * 连接在 effect 跑起来那一刻建,一次 `run*` 一份。
 */
export const provideRemoteDbClient =
  (remote: RemoteSql) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, DbClient>> =>
    Effect.provideServiceEffect(
      self,
      DbClient,
      Effect.sync(() => DbClient.make(connectTo(proxyDrizzle(remote)))),
    );
