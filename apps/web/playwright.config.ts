import { defineConfig, devices } from "@playwright/test";
import { FAKE_BINANCE_URL } from "./e2e/fixtures/sync";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

// E2E(#354):补上单元测试**结构上**够不到的那一层 —— WebAuthn ceremony 由浏览器和认证器裁决,
// mock 掉 authClient 就等于把要验的东西替换掉了。这里用 CDP 虚拟认证器跑真 ceremony。
//
// 只跑 Chromium:虚拟认证器是 CDP 的 WebAuthn 域,Firefox / WebKit 没有对应能力。跨浏览器
// 兼容不是这套测试的题目 —— 题目是「passkey 这条路本身通不通」。
export default defineConfig({
  testDir: "./e2e",
  // 串行跑,**这是量过的**:单个 server + 单个 SQLite(D1),并行只是互相抢(见 CLAUDE.md 里
  // better-auth 的写锁那条)。`--workers=4 --fully-parallel` 实测 1.0 分钟且挂 3 条,串行 52 秒全过 ——
  // 并行在这儿是负收益,别再试了。
  //
  // 时间构成也量过了:51 条各约 1 秒,没有哪条特别慢,所以没有「优化掉某条」这种空间。
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 重试**留着**,但重试过了不算过:CI 里多一步读下面这份 json,`stats.flaky > 0` 就把 job 判红。
  //
  // 为什么两个都要:光有重试的话,「第一次挂、第二次过」会报绿,只在摘要里留一行 `1 flaky` —— 没人
  // 会点开看,于是「这条测试其实不稳」悄悄没了。而直接把 retries 设 0 又丢掉了重试给的那个信息:
  // 一条测试到底是**必挂**还是**偶挂**,重试一次就能分辨,而这两种的排查方向完全不同。
  // 所以:照样重试(拿到诊断信息),但照样判红(不许藏)。
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "playwright-report/results.json" }]]
    : "list",
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
  webServer: [
    {
      // 假 Binance(#372):给「同步」这条链路一个不联网、必定成功、快慢可控的上游。
      // 端口 3099 —— 挑在 vite 那串(3000 起往上探)之外,免得撞上。
      command: "node e2e/fixtures/binance-server.mjs",
      url: `${FAKE_BINANCE_URL}/ping`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // **CI 跑构建产物,本地跑 dev server**。
      //
      // dev server 是按需编译的:2 核 runner 上每条测试第一次碰到某个路由都要现编,实测 24 条跑了
      // 9.6 分钟,而且大量 ceremony 直接撞穿超时 —— 13 条挂,全都挂在「开关拨不开」,不是断言写错。
      // preview 跑的是 build 好的 worker,同样的请求几毫秒就回来。
      //
      // 端口两边都用 3000:passkey 的 origin 校验带端口(rpID 只取 host,但 expectedOrigin 是完整
      // origin),换端口就得同步改 .dev.vars 的 BETTER_AUTH_URL,少一个变量少一处踩。
      //
      // `CLOUDFLARE_ENV=test`(#372):让 @cloudflare/vite-plugin 选 wrangler.jsonc 的 `env.test` 段
      // 并**只**加载 `.dev.vars.test`(把 Binance 指向上面那个假 server)。为什么是环境变量而不是
      // `--mode test` + `.env.test`:插件读的是 `loadEnv(mode, root, ["CLOUDFLARE_"])`,而 vite 的
      // loadEnv 把带前缀的 process.env **优先**并进去 —— 一个变量就够,不必新开一个 vite mode
      // (`--mode test` 会让 `isProduction` 变 false,连带把 build 变成非生产构建)。
      // CI 的 build 步骤也要带同一个变量:`.dev.vars` 是在 **build** 时被烘进 `dist/.dev.vars` 的。
      command: process.env.CI
        ? `CLOUDFLARE_ENV=test pnpm preview --port ${PORT}`
        : `CLOUDFLARE_ENV=test pnpm dev --port ${PORT}`,
      url: `${BASE_URL}/login`,
      // 本地复用已经开着的 dev server(常态);CI 里必须由 Playwright 自己拉起来。
      // **复用有个坑**:若那个 server 是普通 `pnpm dev` 起的,它打的是真 Binance,同步这几条会挂。
      // addBinanceAccount 的失败信息里写了这条线索。
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
