import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 签名的测试**必须在 workerd 里跑**,不能用普通 node vitest:
// node 允许运行时编译 wasm,而 Workers 禁止(`Wasm code generation disallowed by embedder`)——
// 在 node 里跑通了什么都不能说明,反而是假绿灯。整套 vendoring(把 wasm 提成 .wasm 文件让构建期
// 编译、把已编译的 Module 塞回打过补丁的 bundle)存在的唯一理由就是那条禁令,所以验证也只能在那儿做。
//
// 与本包的 vitest.config.ts(纯逻辑,node)并存,由 package.json 的 test 脚本各跑一遍。
// 不需要任何绑定 —— 这里只验「wasm 能实例化 + 签名算得对」。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./tests/server/wrangler.test.jsonc" } })],
  // name 必须与 vitest.config.ts 那个不同 —— 同一个包出两个 project,重名会撞(见根 vitest.config.ts)。
  test: { name: "connectors-provider-rabby-workers", include: ["tests/server/**/*.test.ts"] },
});
