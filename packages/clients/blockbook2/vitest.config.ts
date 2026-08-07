import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "blockbook-client2", include: ["tests/**/*.test.ts"] },
});
