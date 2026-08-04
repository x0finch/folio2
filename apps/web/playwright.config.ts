import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

// E2E(#354):补上单元测试**结构上**够不到的那一层 —— WebAuthn ceremony 由浏览器和认证器裁决,
// mock 掉 authClient 就等于把要验的东西替换掉了。这里用 CDP 虚拟认证器跑真 ceremony。
//
// 只跑 Chromium:虚拟认证器是 CDP 的 WebAuthn 域,Firefox / WebKit 没有对应能力。跨浏览器
// 兼容不是这套测试的题目 —— 题目是「passkey 这条路本身通不通」。
export default defineConfig({
  testDir: "./e2e",
  // dev server 是单实例、底下是一个 SQLite(D1),并行写会互相踩(见 CLAUDE.md 里 better-auth 的
  // 写锁那条)。这几条测试总共几秒,不值得为并行去拆库。
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // 默认 5s 不够:dev server 是按需编译的,某条测试第一次碰到某个路由 / server fn 时那一下明显慢,
  // 而 better-auth 在 D1 上还有写锁排队(CLAUDE.md 里那条)。实测连着跑时偶发 5-8s。
  // 单跑过、连跑挂的 flaky 基本都是这个,不是断言写错。
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // ceremony 真卡住时不要干等到默认 30s。
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // **CI 跑构建产物,本地跑 dev server**。
    //
    // dev server 是按需编译的:2 核 runner 上每条测试第一次碰到某个路由都要现编,实测 24 条跑了
    // 9.6 分钟,而且大量 ceremony 直接撞穿超时 —— 13 条挂,全都挂在「开关拨不开」,不是断言写错。
    // preview 跑的是 build 好的 worker,同样的请求几毫秒就回来。
    //
    // 端口两边都用 3000:passkey 的 origin 校验带端口(rpID 只取 host,但 expectedOrigin 是完整
    // origin),换端口就得同步改 .dev.vars 的 BETTER_AUTH_URL,少一个变量少一处踩。
    command: process.env.CI ? `pnpm preview --port ${PORT}` : `pnpm dev --port ${PORT}`,
    url: `${BASE_URL}/login`,
    // 本地复用已经开着的 dev server(常态);CI 里必须由 Playwright 自己拉起来。
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
