import { describe, it } from "vitest";

// #527 · getSession
//
// **这个 handler 在这套 harness 里跑不起来,而且是在 import 那一步就跑不起来。**
//
// 实测:只要 `import "@/lib/server/session/get"`,整个文件就加载失败 ——
// `Missing "#tanstack-router-entry" specifier in "@tanstack/start-server-core"`。
// 它经 `getRequestHeaders()` 拉进 TanStack Start 的 server 入口,而那个入口只在应用 Worker
// 里才存在;这套 workers-pool 配置**刻意只绑 DB**、不加载应用 Worker(理由写在
// `tests/server/wrangler.test.jsonc`:不为了跑一个函数把整个应用拉起来)。
//
// 所以连 `describe.skip` 都不够 —— 那也要先 import。这个文件因此不 import 被测模块,
// 只留占位与去处。
//
// 它还要第二样东西:模块级的 better-auth 实例(`BETTER_AUTH_URL`、密钥、它自己那套表)。
// 两样都补上,等于把整个应用装进这套测试,把其余 53 个 handler 的启动开销一起抬上去。
//
// **会话这条路真正该测的地方在 e2e**:`apps/web/e2e/` 的登录、锁屏、多标签几条跑的是真浏览器 +
// 真 Worker,`getSession` 每次导航都在里面。
describe("getSession", () => {
  it.skip("已登录 → 返回用户(要请求上下文 + 应用 Worker;见文件头,归 e2e)", () => {});
  it.skip("没登录 → 返回 null 而不是抛错(同上)", () => {});
  it.skip("会话过期 → 当成没登录(同上)", () => {});
  it.skip("返回体里不许有敏感字段(同上)", () => {});
});
