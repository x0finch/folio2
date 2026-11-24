import viteReact from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Standalone config: tests don't load the Cloudflare/SSR plugin chain from vite.config.ts.
// tests/server/** are D1 workers-pool tests, run by vitest.workers.config.ts.
//
// Environment follows the file extension: jsdom costs ~0.5s per test file, so `.test.ts` runs in
// node and only `.test.tsx` (component tests) pays for it. Don't collapse this into one setting.
const shared = {
  globals: true,
  setupFiles: ["./tests/setup.ts"],
  exclude: [...configDefaults.exclude, "tests/server/**"],
};

// Each project needs its own `resolve`: a top-level one isn't inherited, and vite.config.ts
// isn't loaded here.
const resolve = { tsconfigPaths: true };

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        // Pure logic: formatting, aggregation, snapshot shaping. No DOM, no cost.
        plugins: [viteReact()],
        resolve,
        test: { ...shared, name: "logic", environment: "node", include: ["tests/**/*.test.ts"] },
      },
      {
        // Component tests — these actually render, so they get the fake browser.
        plugins: [viteReact()],
        resolve,
        test: { ...shared, name: "dom", environment: "jsdom", include: ["tests/**/*.test.tsx"] },
      },
    ],
  },
});
