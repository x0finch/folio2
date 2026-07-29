import { defineConfig } from "vitest/config";

// 纯逻辑测试(解析 / 限流闸)走普通 node 环境。
// **签名那部分不在这里测** —— node 允许运行时编译 wasm,过了是假绿灯;真实约束只有 workerd 有
// (见 src/sign.ts 顶部)。所以签名的验证在 tests/server 那档 workers-pool 里。
export default defineConfig({
  test: {
    name: "connectors-provider-rabby",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/server/**"],
  },
});
