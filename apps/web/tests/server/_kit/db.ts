import { env } from "cloudflare:test";
import { CurrentUser, Database, dbClientLayer } from "@folio/db";
import { Effect } from "effect";

// **夹具那一侧的库把手。**
//
// 被测代码走 `call()`(生产内核);夹具要的是另一件事:往库里塞一行、或者读回来看看落对了没有。
// 那种粒度用 Promise 最直白,所以这里把聚合 `Database` 上的域操作包成 Promise 形状。
//
// 它**不是第二条生产路**:每个方法底下都是 provide 同一个 `Database` + 真 D1 再跑一次,
// 而夹具本来就是「一次调用 = 一次独立的库操作」。

type Promisified<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : S[K];
};

const runOnce = <A>(userId: string, effect: Effect.Effect<A, never, Database>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Database.Default),
      Effect.provide(dbClientLayer(env)),
      Effect.provideService(CurrentUser, userId),
    ),
  );

const promisify = <S extends object>(userId: string, pick: (db: Database) => S): Promisified<S> =>
  new Proxy({} as Promisified<S>, {
    get:
      (_t, key) =>
      (...args: unknown[]) =>
        runOnce(
          userId,
          Effect.flatMap(Effect.map(Database, pick), (svc) => {
            const method = (svc as Record<string | symbol, unknown>)[key];
            if (typeof method !== "function") {
              throw new TypeError(`不是这个域上的方法:${String(key)}`);
            }
            // 夹具只用不会失败的那些 op;真会失败的(attach 之类)由用例自己经 `call` 走。
            return (method as (...a: unknown[]) => Effect.Effect<unknown>).apply(svc, args);
          }) as Effect.Effect<unknown, never, Database>,
        ),
  });

/** `db(USER).accounts.list()` —— 夹具读写库的唯一入口。 */
export const db = (userId: string) => ({
  accounts: promisify(userId, (d) => d.accounts),
  portfolios: promisify(userId, (d) => d.portfolios),
  settings: promisify(userId, (d) => d.settings),
  snapshots: promisify(userId, (d) => d.snapshots),
  manual: promisify(userId, (d) => d.manual),
  tags: promisify(userId, (d) => d.tags),
  tabPins: promisify(userId, (d) => d.tabPins),
  cache: promisify(userId, (d) => d.cache),
});

/** 直接数行数 —— 「一行都不许落库」这类断言要它,经域操作反而看不全。 */
export const countRows = async (table: string, userId: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};
