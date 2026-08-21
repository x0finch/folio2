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

// `@/*` → `src/*`(#497)。**必须逐 project 写,写在顶层不生效** —— 每个 project 是一份独立的
// vite 配置,顶层的 `resolve` 不下传(探针实测:顶层版本仍报 "Cannot find package '@/…'")。
// 这份配置也不加载 `vite.config.ts`(那条链是给构建产物的),所以那边的同名设置在这里不算数。
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
