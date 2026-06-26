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

export type Db = ReturnType<typeof getDb>;
