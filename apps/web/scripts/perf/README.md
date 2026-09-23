# perf:cpu —— 每个端点吃多少服务端 CPU

```sh
pnpm --filter @folio/web perf:cpu                     # 构建 → 灌数据 → 全部端点各 30 发
pnpm --filter @folio/web perf:cpu --no-build --only fn-getSnapshots-now,doc-root-authed
pnpm --filter @folio/web perf:cpu --cold --only fn-getValuationSettings   # 第一发(冷 isolate)
pnpm --filter @folio/web perf:cpu --list              # 有哪些端点
pnpm --filter @folio/web perf:cpu --help              # 全部参数
```

Cloudflare Workers 免费档每个请求只有 **10ms CPU**。做性能的活,改之前、改之后各跑一遍,
把两张表贴进 PR。

## 为什么不能看 `durationMs` 日志

`src/lib/server/runtime.ts` 的 `withServerFnTiming` 用 `performance.now()` 记每个 server fn
的耗时。**在 workerd 里这个时钟在同步计算期间是停的**(防计时侧信道,只在 I/O 边界前进),所以
那行日志只看得见等 D1 的时间,看不见 CPU;而且它只包住 handler 本体,框架在前后做的事全不算。
实测它比真实 CPU 低 2–10 倍(`getValuationSettings` 日志 2ms,真实约 20ms)。FOL-40 按它排过
一次优先级,排错了。

这个脚本从**外面**量:V8 采样 profiler 按真实时间打点,不受那个时钟影响。

## 它做了什么

1. `vite build`(`--no-build` 跳过)—— 测的是 `dist/server`,也就是 `wrangler deploy` 发出去的
   那份,不是 `vite dev` 的逐模块转译。
2. 在 **专用本地库** `apps/web/.wrangler/perf-state/` 上跑迁移。开发用的 `.wrangler/state`
   一行都不碰(Miniflare 按 `--persist-to` 目录分库)。整个 `.wrangler/` 已被 gitignore。
3. 确保压测用户 `perf@folio.test` 存在(没有就经 better-auth 的 HTTP 接口注册),然后清空
   业务表、直写 SQLite 灌一份确定性数据:默认 8 个账户、60 个代币、30 天逐小时快照
   (约 5.8k 张快照、4.4 万行持仓)。大小可调:`--accounts` / `--tokens` / `--days`。
   `--no-seed` 沿用上次的数据。
4. `wrangler dev --config dist/server/wrangler.json --inspector-port …` 起 worker,登录拿会话
   cookie,经 inspector(CDP)开 `Profiler`,每个端点先预热 5 发、再顺序发 30 发,停采样。
5. 退出时(正常、报错、Ctrl-C)把 wrangler 连同 workerd 子进程一起停掉。

默认端口 3300 / inspector 9330,避开 `pnpm dev` 的 3000,两者可以同时开。

## 需要 `apps/web/.dev.vars`

至少要有 `BETTER_AUTH_SECRET` 和 `SECRETS_KEY`(抄 `.dev.vars.example`),缺了直接报错退出。
脚本会给构建产物另写一份 `dist/server/.dev.vars`,其中:

- `BETTER_AUTH_URL` 改成 perf worker 自己的 origin(`http://127.0.0.1:3300`)—— better-auth 的
  CSRF 按它校验,必须和实际访问的 origin 一致。你的 `.dev.vars` 里写 `http://localhost:3000` 就行。
- `LOG_LEVEL` / `LOG_PRETTY` 被丢掉,生效的是 `wrangler.jsonc` 里的生产值 —— 本地的 debug 彩色
  日志每条都是真 CPU,线上没有。

任何值都不会被打印。

## 怎么读输出

```
   endpoint                  status  mean   p50   max  proc  wall p50  owners (mean ms/req)
!  fn-getValuationSettings*  200     22.0  21.2  44.9  20.6      24.4  Effect 10.2 · TanStack Start 2.8 · V8 native 2.3 · GC 2.0
   static-favicon            200      0.0   0.0   0.0   4.0       5.0
```

- **mean / p50 / max** —— 采样得到的每请求 CPU 毫秒(JS 自耗时 + GC)。`!` = mean 超过
  `--budget-ms`(默认 10)。**mean 是主数字**,预算判定、前后对比都看它。
- **proc** —— 交叉校验:不开采样再发同样多发,读内核记的 workerd 进程上 CPU 时间
  (`/proc/<pid>/task/*/schedstat`)。它不靠采样,所以采样线程被饿的时候照样准;但它**多算**了
  本地才有的东西 —— 同进程里跑的本地 D1(SQLite)、资源路由、HTTP 解析。`static-favicon` 那一行的
  proc 就是这层本地底座(几毫秒)。mean 与 proc 大体相当 → 采样可信;mean 远高于 proc → 采样被
  放大了(多半是机器忙),这次的数别用。非 Linux 上显示 `—`。
- 端点名后的 **`*`** —— 这一行的 CPU 有四分之一以上来自「稀疏样本」:isolate 闲着时 V8 的采样会停,
  恢复后第一个样本带着整段空档(几毫秒)记在当时那一帧上。总数(mean)仍然可用,但它落到哪一发
  请求上是碰运气,所以 p50 / max 只是粗估。便宜的端点(几毫秒)常见。
- **wall p50** —— Node 这边看到的往返时间。wall 远大于 CPU → 这个端点在等 I/O(本地 D1 或者
  被挡住的上游请求),CPU 数字本身仍然可信,但它不是你以为的那条路径。
- **status** —— 与期望不符会写成 `401≠200`:这时量的是报错路径,数字作废。
- **owners** —— 这些毫秒落在谁身上。按构建产物里 rolldown 留下的 `//#region <源路径>` 注释把
  每个采样帧映射回源模块,再归到包:`Effect`、`TanStack Start`、`TanStack Router`、`seroval`、
  `better-auth`、`D1 driver`(`cloudflare-internal:d1-api`,主要是行 → JS 对象)、`React SSR`、
  `GC`、`V8 native`、`app code (@folio/*)`,其余第三方按包名。不依赖 chunk 文件名,构建怎么切都准。
- **`static-favicon`** 是对照组:静态资源不进 worker,应当是 0。它不是 0 就说明量法坏了。

输出目录(默认 `.wrangler/perf-state/runs/<时间戳>/`,`--out` 可改):

- `<端点>.cpuprofile` —— 原始 profile,Chrome DevTools › Performance › 载入,看火焰图。
- `summary.json` —— 每端点的逐请求 CPU、归属分组、最热的 25 个源模块、GC / `(program)` 时间、
  数据集大小、运行前后的机器负载。
- `wrangler.log` —— 构建、迁移与 worker 的日志。

`--fail-over-budget`:任一端点 mean 超预算就以 1 退出,留给以后接 CI(现在没接)。

## 口径与局限(引用数字前先看)

- **这是本机的 CPU 毫秒,不是 Cloudflare 边缘的。** 两者没有换算系数。可以搬过去的是**形状**
  (谁占大头、端点之间的比例、改动前后的差),不是绝对值。线上真值看 Workers Logs 的 `cpuTime`。
- **机器忙的时候数字整体偏高**(被抢走的时间片会落在正在跑的帧上)。开测前负载高于核数 ¾ 时
  脚本会提醒;对比前后两次时,两次都要在安静的机器上跑。
- CPU 是上界:采样间隔里的短暂 I/O 等待会被算进前一个 JS 帧。
- `(program)` 不计入(V8 说不清归谁的原生时间),与最初那轮测量同口径;数值在 `summary.json` 里。
- 逐请求拆分靠「profile 时间戳与 Node 的 `process.hrtime` 是同一个单调时钟」(Linux 上成立,
  实测对得上)。对不上时只给 mean,p50 / max 显示 `—`。
- 一次一发,不测并发;不测写路径;数据集里**刻意没有 manual 账户** —— 有它的话
  `getSnapshots` / `getPortfolioHistory` 每次都会去 CoinGecko 取今日价,断网环境里一发要等几十秒,
  量到的是网络。
- `--cold` 的第一发把模块求值、better-auth / Effect 的首调初始化都算进去了;Cloudflare 把 worker
  启动(模块解析求值)记在另一份约 400ms 的预算里,所以冷启动这个数和线上计费不是一回事。

## 加一个端点

在 `endpoints.mjs` 的 `ENDPOINTS` 里加一行:server fn 写 `fn: "<handler 名>"`(只支持 GET,id 从
构建出的 manifest 按名字反查)+ 需要的话 `data: (ctx) => ({ … })`;文档或普通路由写 `path`。
非 200 的期望状态写 `expect`。
