import type { D1Database } from "@cloudflare/workers-types";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { account, passkey, session, user, verification } from "./schema/auth";

// **怎么摸到 D1** —— 包内唯一一处。
//
// `D1Database` 是 **显式 `import type`,不靠 ambient 全局**。它本来是全局的
// (`@cloudflare/workers-types` 装进 tsconfig 的 `types` 就有),而那样写的代价是**每个消费者的
// tsconfig 都得自己 opt-in** —— 本包的 `exports` 指向源码(内部包无构建步骤),所以 `DbEnv`
// 一出包,消费者的 tsc 就要编译本文件。`@folio/sync` 早就为此在自己的 tsconfig 里加了那一行;
// `@folio/oracle` 开始依赖本包时本来会是第三个。显式 import 之后这条依赖跟着文件走,
// 消费者什么都不用配(实测:去掉 oracle 那行 `types`,两边都照过)。
//
// 底下还有一个 `createAuthAdapter`:它不走 userId 作用域的包装层(better-auth 自己管),
// 但它是除 `domains/` 之外**唯一**需要 db 句柄的地方,所以住在句柄旁边。

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

// drizzle 句柄的类型。**不叫 `Db`** —— 那个名字归门面(曾经的 `createDb`
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
