import viteReact from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Dedicated Vitest config so tests don't load the Cloudflare/SSR plugin chain
// from vite.config.ts (that runtime is for the built worker, not unit tests).
// tests/server/** are D1 workers-pool tests → run by vitest.workers.config.ts.
//
// **Environment follows the file extension, and that split is the point.**
// Standing up a fake browser (jsdom: synthesizing `document`, `window`, …) costs
// ~0.5s per test FILE, charged whether or not the test ever touches the DOM.
// This suite had 45 files paying it and exactly one — the `.tsx` one — using it:
// 25s of environment setup for 0.4s of assertions. Keying the environment off
// the extension makes the cheap case the default, and a test can only opt into
// the expensive one by being `.tsx`, which a component test has to be anyway
// since it renders JSX.
//
// So: don't "simplify" this back into a single `environment` setting, and don't
// reach for a `// @vitest-environment jsdom` docblock instead — that puts the
// cost back behind a line someone has to remember to write. If a `.ts` test
// seems to need the DOM, it's testing a component and belongs in a `.tsx` file.
const shared = {
  globals: true,
  setupFiles: ["./tests/setup.ts"],
  exclude: [...configDefaults.exclude, "tests/server/**"],
};

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        // Pure logic: formatting, aggregation, snapshot shaping. No DOM, no cost.
        plugins: [viteReact()],
        test: { ...shared, name: "logic", environment: "node", include: ["tests/**/*.test.ts"] },
      },
      {
        // Component tests — these actually render, so they get the fake browser.
        plugins: [viteReact()],
        test: { ...shared, name: "dom", environment: "jsdom", include: ["tests/**/*.test.tsx"] },
      },
    ],
  },
});
