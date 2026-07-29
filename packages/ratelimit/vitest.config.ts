import { defineConfig } from "vitest/config";

// 纯逻辑 —— 时钟和 sleep 全靠注入,所以不需要 fake timer、也不需要 workerd。
// Cache API 那一档同样注入(node 里没有 `caches`),见 tests/cooldown.test.ts。
export default defineConfig({
  test: {
    name: "ratelimit",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
