import { drizzle } from "drizzle-orm/d1";

// db 实例所需的最小 env 形状(只用到 D1 绑定)。
export interface DbEnv {
  DB: D1Database;
}

// 包内私有:不在 index 导出,调用方无法绕过包装层直接拼查询。
// 不做模块级缓存:Workers 全局作用域跨请求共享,而 env.DB 按请求注入;
// drizzle(env.DB) 很轻,每次创建即可。
export function getDb(env: DbEnv) {
  return drizzle(env.DB);
}

// drizzle 句柄的类型。**不叫 `Db`** —— 那个名字归门面(`db.ts` 的 `createDb` 返回值),
// 两个都叫 Db 的时候读代码得先猜是哪个。
export type Drizzle = ReturnType<typeof getDb>;
