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
    command: `pnpm dev --port ${PORT}`,
    url: `${BASE_URL}/login`,
    // 本地复用已经开着的 dev server(常态);CI 里必须由 Playwright 自己拉起来。
    reuseExistingServer: !process.env.CI,
    // 冷启动要编译整个 app,15s 不够。
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
