import { defineConfig, devices } from "@playwright/test";
import { FAKE_BINANCE_URL } from "./e2e/fixtures/sync";

// Port 3100, not 3000: keeps e2e apart from the daily dev server, which hits a different database
// (e2e runs with `CLOUDFLARE_ENV=test`) and would be reused locally against the real Binance.
const PORT = 3100;
// https: `.dev.vars.test` sets BETTER_AUTH_URL to https://localhost:3100 and vite.config.ts derives
// its cert (HTTP/2) from it. Port and scheme must match that file exactly: expectedOrigin is the full origin.
const BASE_URL = `https://localhost:${PORT}`;

// E2E covers what unit tests can't: WebAuthn ceremonies are judged by the browser and
// authenticator, so they run against a CDP virtual authenticator. Chromium only (CDP WebAuthn domain).
export default defineConfig({
  testDir: "./e2e",
  // Serial: one server + one SQLite (D1) means parallel runs just contend for the write lock
  // (measured: 4 workers was slower and flaked).
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Retries stay, but CI reads the JSON report and fails the job when `stats.flaky > 0`, so a
  // pass-on-retry can't hide an unstable test.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "playwright-report/results.json" }]]
    : "list",
  // Default 5s is too short: the dev server compiles on demand and better-auth queues on the D1 write lock.
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    // Self-signed cert: the equivalent of clicking through the browser warning.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    // Fail fast when a ceremony hangs instead of waiting the default 30s.
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Fake Binance: an offline, always-succeeding, controllable upstream for the sync flow.
      // Port 3099 sits outside both vite port ranges.
      command: "node e2e/fixtures/binance-server.mjs",
      url: `${FAKE_BINANCE_URL}/ping`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // CI runs the build output (the dev server compiles per route on a 2-core runner and times
      // out ceremonies); locally it runs the dev server. `.dev.vars.test`'s BETTER_AUTH_URL must
      // match PORT. `CLOUDFLARE_ENV=test` makes @cloudflare/vite-plugin pick `env.test` and load
      // only `.dev.vars.test`; an env var suffices since the plugin reads `loadEnv(mode, root,
      // ["CLOUDFLARE_"])`, while `--mode test` would make the build non-production. CI's build step
      // needs it too: `.dev.vars` is baked into `dist/.dev.vars` at build.
      command: process.env.CI
        ? `CLOUDFLARE_ENV=test pnpm preview --port ${PORT}`
        : `CLOUDFLARE_ENV=test pnpm dev --port ${PORT}`,
      url: `${BASE_URL}/login`,
      // The health probe needs its own flag, separate from `use.ignoreHTTPSErrors`.
      ignoreHTTPSErrors: true,
      // Reuse a running server locally; port 3100 only ever hosts the `CLOUDFLARE_ENV=test` server.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
