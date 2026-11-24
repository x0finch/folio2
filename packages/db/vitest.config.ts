import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1 tests run in workerd via @cloudflare/vitest-pool-workers; migrations are applied in the setup file.
export default defineConfig(async () => {
  const migrationsDir = fileURLToPath(new URL("drizzle", import.meta.url));
  const migrations = await readD1Migrations(migrationsDir);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" }, // provides the DB binding + compat
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } }, // test-only: migrations array
      }),
    ],
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  };
});
