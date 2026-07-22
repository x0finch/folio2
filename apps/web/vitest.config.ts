import viteReact from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Dedicated Vitest config so tests don't load the Cloudflare/SSR plugin chain
// from vite.config.ts (that runtime is for the built worker, not unit tests).
// Component tests run in jsdom with @testing-library/react.
// tests/server/** are D1 workers-pool tests → run by vitest.workers.config.ts, excluded here.
export default defineConfig({
  plugins: [viteReact()],
  test: {
    environment: "jsdom",
    globals: true,
    passWithNoTests: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [...configDefaults.exclude, "tests/server/**"],
  },
});
