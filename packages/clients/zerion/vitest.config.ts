import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "zerion-client", include: ["tests/**/*.test.ts"] },
});
