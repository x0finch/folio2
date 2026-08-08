import { env } from "cloudflare:workers";
import { createDb, type Db } from "@folio/db";

// server-only 门面(引 cloudflare:workers,客户端不可引)。全应用唯一 createDb 调用点 —— 其余处一律
// import { db } 后直接 db.xxx。get 在访问时才碰 env → 模块加载期不触发;env 在 fetch 与 scheduled
// 上下文均可用(见 configureLogging),故 cron 路径也走此 db。方法均为无 this 闭包,直接返回即可调用。
//
// **facade 按 env 记忆化,不是每次属性访问重建一份**(#394)。原来那句「createDb 只是绑定 env 的
// 廉价闭包对象」在 ADR 0037 之后不再成立:它现在还要给每个已迁领域各建一个 per-user 转接器。
// 而这是**每次 `db.` 都发生**的 —— `getPortfolioOverview` 一次请求就有 23 次属性访问。
//
// env 引用变了就重建(Workers 每请求注入一份),所以这是「按 env 记忆化」而不是「建一次用到底」。
// 模块级可变状态在 Workers 上是刻意的(CODING.md:Layer memoisation 是 per-run 的,跨请求要活的
// 东西只能在模块级)。
let cached: { env: unknown; facade: Db } | null = null;

const facade = (): Db => {
  if (cached?.env !== env) cached = { env, facade: createDb(env) };
  return cached.facade;
};

export const db: Db = new Proxy({} as Db, {
  get: (_target, prop: string) => (facade() as Record<string, unknown>)[prop],
});
