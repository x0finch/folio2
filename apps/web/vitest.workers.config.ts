import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1-touching server orchestration needs real workerd/Miniflare D1; jsdom tests can't cover it.
export default defineConfig(async () => {
  const migrationsDir = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));
  const migrations = await readD1Migrations(migrationsDir);
  return {
    // `cloudflareTest` doesn't carry tsconfig paths; without this `@/…` imports fail in workerd.
    resolve: { tsconfigPaths: true },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/server/wrangler.test.jsonc" }, // DB binding only, no app worker
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["tests/server/**/*.test.ts"],
      setupFiles: ["./tests/server/apply-migrations.ts"],
    },
  };
});
