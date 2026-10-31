import { defineConfig, devices } from '@playwright/test'

import { BASE_URL } from './support/env.mjs'

/**
 * End-to-end tests against the built app (`pnpm build` first), a local Worker with a
 * throwaway D1 and a stub for the market-data APIs (scripts/serve.mjs).
 *
 * - `journey`: the functional flow, run in CI.
 * - `screenshots`: saves the key screens to `screenshots/` (desktop + phone, light + dark)
 *   for PR comparisons; run on demand with `pnpm --filter @folio/e2e screenshots`.
 */
export default defineConfig({
  testDir: './tests',
  // One local database shared by the tests.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'journey', testMatch: /journey\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
