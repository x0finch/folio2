import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1 测试走 @cloudflare/vitest-pool-workers(Miniflare D1,workerd 运行)。
// 0.16.x 新 API:cloudflareTest 插件 + readD1Migrations(均从包根导入)。
// 迁移在 setupFile 里用 applyD1Migrations 应用到测试库。
export default defineConfig(async () => {
  const migrationsDir = fileURLToPath(new URL("drizzle", import.meta.url));
  const migrations = await readD1Migrations(migrationsDir);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" }, // 提供 DB(D1)绑定 + compat
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } }, // 测试专用:迁移数组
      }),
    ],
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  };
});
