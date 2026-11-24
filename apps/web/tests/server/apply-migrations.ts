import { applyD1Migrations, env } from "cloudflare:test";
import { setRateLimitScopeForTests } from "@folio/client-core/testing";

// Setup runs outside per-test storage isolation and may run repeatedly; applyD1Migrations is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The tests run the app's real wiring and `runPromise` sits inside the code under test, so there is no
// place to provide a service: set the process-wide default tier instead. Waiting on the gate would
// stretch the suite from 1s to tens of seconds (the keyless tier is 10 requests/minute).
setRateLimitScopeForTests("none");
