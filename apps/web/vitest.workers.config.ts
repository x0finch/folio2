import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 服务端 lib(tests/server/**)的 workers-pool 测试:在 workerd(Miniflare D1)里跑碰 D1 的服务端编排
// (createManualAccount / materializeManualCreds 等),补 jsdom 单测覆盖不到的真实往返。与主 vitest.config.ts
// (jsdom 组件/纯逻辑)并存,由 package.json 的 test 脚本各跑一遍。迁移读 @folio/db 的 drizzle。
export default defineConfig(async () => {
  const migrationsDir = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));
  const migrations = await readD1Migrations(migrationsDir);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/server/wrangler.test.jsonc" }, // 仅 DB 绑定,不加载 app worker
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["tests/server/**/*.test.ts"],
      setupFiles: ["./tests/server/apply-migrations.ts"],
    },
  };
});
