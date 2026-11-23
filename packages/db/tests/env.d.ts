// Test bindings: DB (Miniflare D1) plus the injected migrations array.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
