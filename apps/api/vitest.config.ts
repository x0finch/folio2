import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests run Miniflare's D1 and many sync alarms; the default 5 s is tight on slow runners.
    testTimeout: 20_000,
  },
})
