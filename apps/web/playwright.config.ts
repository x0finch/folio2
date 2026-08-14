import { defineConfig, devices } from "@playwright/test";
import { FAKE_BINANCE_URL } from "./e2e/fixtures/sync";

// 3100,**不是 3000** —— 这一套要跟日常的 dev server 彻底分开。两边曾经都用 3000,理由是「passkey 的
// origin 校验带端口,少一个变量少一处踩」;代价是它俩抢同一个端口而**连的是不同的库**(e2e 带
// `CLOUDFLARE_ENV=test`,走 folio-e2e),于是 e2e 一跑,浏览器里正开着的那个 dev 会话就落到一个查无此人的
// 库上,登录报「Invalid email or password」——密码没错,人不在那儿。顺带还有一个:`reuseExistingServer`
// 在本地会直接**复用**你那个 dev server,而它打的是真 Binance,同步那几条必挂。挪开之后两个都没了。
const PORT = 3100;
// https —— 这一套跑的是 `CLOUDFLARE_ENV=test`,而 `.dev.vars.test` 里的 BETTER_AUTH_URL 就是
// https://localhost:3100;vite.config.ts 正是照着那个值决定配不配证书的(要的是 HTTP/2),于是
// dev / preview 都只听 https。**端口和 scheme 都得和那个文件逐字对上**:expectedOrigin 是完整 origin,
// 差一个字符每个 ceremony 都失败(rpID 只取 host,不受影响)。
const BASE_URL = `https://localhost:${PORT}`;

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
    // 证书是现签的自签名证书,没有哪个 CA 认它 —— 浏览器里点一下「继续前往」的那一步,在这里就是这个开关。
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    // ceremony 真卡住时不要干等到默认 30s。
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 假 Binance(#372):给「同步」这条链路一个不联网、必定成功、快慢可控的上游。
      // 端口 3099 —— 落在两串 vite 端口之外(日常 dev 从 3000 往上探,e2e 从 3100 往上),免得撞上。
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
      // 端口是 3100(见文件顶部):跟日常 dev 的 3000 分开,换端口时 `.dev.vars.test` 的
      // BETTER_AUTH_URL 要一起动 —— expectedOrigin 带端口。
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
      // 探活也要认这张自签名证书 —— 这个开关和 `use.ignoreHTTPSErrors` 是两回事,少了它 server 起来了
      // 也会被判成没起来。
      ignoreHTTPSErrors: true,
      // 本地复用 3100 上已经开着的那个(连着跑几轮时省下每次重起);CI 里必须由 Playwright 自己拉起来。
      // 端口挪开之后这条不再有风险:3100 上只可能是 `CLOUDFLARE_ENV=test` 起的 server。以前两边都用
      // 3000,复用到的往往是普通 `pnpm dev`——它打的是真 Binance,同步那几条必挂;那条线索还留在
      // addBinanceAccount 的失败信息里。
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
