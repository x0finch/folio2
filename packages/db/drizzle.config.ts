import { defineConfig } from "drizzle-kit";

// generate 只用 schema/dialect/out;dbCredentials 仅 remote push/studio 时需要。
// 落地流程:drizzle-kit generate → wrangler d1 migrations apply(见 package.json 脚本)。
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_D1_TOKEN ?? "",
  },
});
