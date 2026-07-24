import { env } from "cloudflare:workers";
import { createDb, type Db } from "@folio/db";

// server-only 门面(引 cloudflare:workers,客户端不可引)。全应用唯一 createDb 调用点 —— 其余处一律
// import { db } 后直接 db.xxx。每次属性访问用「当前 env」造一份 facade 再取方法(createDb 只是绑定 env
// 的廉价闭包对象)。get 在访问时才碰 env → 模块加载期不触发;env 在 fetch 与 scheduled 上下文均可用
// (见 configureLogging),故 cron 路径也走此 db。方法均为无 this 闭包,直接返回即可调用。
export const db: Db = new Proxy({} as Db, {
  get: (_target, prop: string) => (createDb(env) as Record<string, unknown>)[prop],
});
