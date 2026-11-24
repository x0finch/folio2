import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "upstreams", include: ["tests/**/*.test.ts"] },
});
