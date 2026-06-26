import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// better-auth 身份表(email+password 核心:user/session/account/verification)。
// 字段名(property)须与 better-auth 约定一致;SQL 列名用 snake_case 与业务表统一。
// 注:`@better-auth/cli` 当前版本(1.4.x)落后于 better-auth 1.6,generate 在本仓 jiti
// 解析下失败(拉到旧 better-call),故按官方 Drizzle schema 定义(arch-design §4.2 允许)。
// 运行期由 better-auth 1.6.21 + better-call 1.3.7 正常工作(curl 注册/登录已验证)。

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// better-auth 拥有的「登录方式链接」表(每个用户每种登录方式一行):
// email+password 在此存凭据(`password` 哈希 / providerId="credential"),OAuth 存第三方
// provider 账号链接(accessToken 等)。表名 `account` 是 better-auth 约定,勿改。
// ⚠️ 与业务表 `accounts`(schema.ts,被追踪的余额来源:钱包/CEX/manual)**完全无关**,
//    只是单复数相近,别混淆:这张是「认证」,那张是「资产账户」。
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});
