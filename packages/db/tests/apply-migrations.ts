import { applyD1Migrations, env } from "cloudflare:test";

// Setup runs outside per-test storage isolation and may run many times; applyD1Migrations only applies pending migrations, so it's idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
