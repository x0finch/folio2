import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { account, passkey, session, user, verification } from "./schema/auth";

// **怎么摸到 D1** —— 包内两半(queries/ 与 stores/)唯一共用的东西。
//
// 底下还有一个 `createAuthAdapter`:它不属于任何一半(better-auth 不走 userId 作用域的包装
// 层),但它是除那两半之外**唯一**需要 db 句柄的地方,所以住在句柄旁边。

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

// drizzle 句柄的类型。**不叫 `Db`** —— 那个名字归门面(`queries/facade.ts` 的 `createDb`
// 返回值),两个都叫 Db 的时候读代码得先猜是哪个。
export type Drizzle = ReturnType<typeof getDb>;

// —— better-auth 的 Drizzle adapter ——
//
// 唯一例外(工程原则 #6):better-auth 需要一个 Drizzle adapter 才接得上 db。这里在包内部用
// 私有的 `getDb` + 身份表把 adapter 造好交出去,**不**暴露 db 句柄或 schema 本身。
export function createAuthAdapter(env: DbEnv) {
  return drizzleAdapter(getDb(env), {
    provider: "sqlite", // D1 = SQLite
    schema: { user, session, account, verification, passkey },
  });
}
