import type { D1Database } from "@cloudflare/workers-types";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { account, passkey, session, user, verification } from "./schema/auth";

// `D1Database` is an explicit `import type`, not an ambient global, so consumers' tsconfigs need no opt-in (the package exports source).

export interface DbEnv {
  DB: D1Database;
}

// Package-private. No module-level cache: Workers globals are shared across requests while env.DB is injected per request, and drizzle(env.DB) is cheap.
export function getDb(env: DbEnv) {
  return drizzle(env.DB);
}

export type Drizzle = ReturnType<typeof getDb>;

// better-auth's Drizzle adapter is the one exception: built here from the private `getDb` and the identity tables, without exposing the handle or schema.
export function createAuthAdapter(env: DbEnv) {
  return drizzleAdapter(getDb(env), {
    provider: "sqlite", // D1 = SQLite
    schema: { user, session, account, verification, passkey },
  });
}
