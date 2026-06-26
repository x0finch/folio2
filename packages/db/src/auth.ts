import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { account, session, user, verification } from "./auth-schema";
import { type DbEnv, getDb } from "./client";

// 唯一例外(工程原则 #6):better-auth 需要 Drizzle adapter 接 db。这里在包内部用私有
// getDb + 身份表构造好 adapter 交出去,**不**暴露 db 实例或 schema 句柄本身。
export function createAuthAdapter(env: DbEnv) {
  return drizzleAdapter(getDb(env), {
    provider: "sqlite", // D1 = SQLite
    schema: { user, session, account, verification },
  });
}
