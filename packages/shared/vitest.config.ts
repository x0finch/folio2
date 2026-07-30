import { defineConfig } from "vitest/config";

// 纯逻辑 —— 时钟和 sleep 全靠注入,所以不需要 fake timer、也不需要 workerd。
// 跨 isolate 那一档在这里用注入的假 store 验形状;它在 workerd 里的真实行为见 tests/server。
export default defineConfig({
  test: {
    name: "shared",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // **必须排掉 tests/server** —— 那一档是 workerd 专属的(见 vitest.workers.config.ts)。
    // 不排掉的话它也会在 node 里跑一遍,而 node 没有 `caches`,默认档会静默退回本地 ——
    // 于是那些「Cache API 真的在工作」的断言全部失败,而且看起来像 flaky。
    exclude: ["tests/server/**"],
  },
});
