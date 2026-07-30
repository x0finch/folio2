import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 这一档**必须在 workerd 里跑**,node 上跑通说明不了任何事。
//
// 本包的行为完全建立在两个**运行时**承诺上:第三方包 import 得进来、`setTimeout` 和 `Date.now`
// 老实推进。这两条在 node 上恒成立,在 Workers 上不是白给的 —— 实测 `rate-limiter-flexible`
// 光是 import 就让 workerd **段错误**(它的单一入口 eager require 了 node 的 `cluster`),
// 而那种故障在 node 测试里完全看不见。
//
// 另一半原因是:唯一别的 workerd 套件(apps/web)把闸整体旁路了(那套测的不是限频),
// 所以真闸在 workerd 里的行为只有这里覆盖。
//
// 与本包的 vitest.config.ts(纯逻辑 + 假时钟,node)并存,由 package.json 的 test 脚本各跑一遍。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./tests/server/wrangler.test.jsonc" } })],
  // name 必须与 vitest.config.ts 那个不同 —— 同一个包出两个 project,重名会撞(见根 vitest.config.ts)。
  test: { name: "ratelimit-workers", include: ["tests/server/**/*.test.ts"] },
});
