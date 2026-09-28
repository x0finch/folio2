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

## perf:cpu:jobs —— 定时任务(和队列)每次调用吃多少 CPU

```sh
pnpm --filter @folio/web perf:cpu:jobs                     # 构建 → 灌数据 → 两个 cron 各量一轮
pnpm --filter @folio/web perf:cpu:jobs --no-build --only cron-sweep --reps 3
pnpm --filter @folio/web perf:cpu:jobs --list              # cron-daily / cron-sweep
pnpm --filter @folio/web perf:cpu:jobs --help
```

上面那个 `perf:cpu` 只量读路径。这个量**后台写路径**:整点 sweep(`30 * * * *`,开轮 + 给每个账户投
一条 `sync-account`、给每个用户投 `prices` / `daily-prices` / `fx` / `platforms` / `defi-logos`)与每天
那条(`0 23 * * *`,投 `prune-notes` / `catalogue`)。两个 cron 本体都只投活(FOL-86 / FOL-88),真活在
队列 consumer 里一条一次调用地跑,所以表里分开量:cron 那一次,与**每件活的每一次 consumer 调用**。改 cron 之前、之后各跑一遍,两张表
贴进 PR。基线存在 `baselines/`(`jobs-before-2026-09-28.txt` 是改成队列扇出之前的那一份,里面的
`cron-ref-index` 行是刷全局映射表还在 Worker 里跑的时候量的)。

**全局代币映射表不在这里量了**(FOL-85,ADR 0056):那一趟(基线里 ≈ 390ms)挪到了 GitHub Actions
里的 Node 脚本(`scripts/ref-index/refresh.ts`),不再吃 Worker 的 10ms,所以 `cron-ref-index` 这一格
没了。harness 仍要一张非空的表(sweep 靠它认链上的币):灌完数据后用**同一个脚本**
`--local` 对着 perf 库刷一次(指到假上游),日志里打出它的计数与墙钟,不进表。

**本机数字 ≠ 边缘数字。** 两者没有换算系数;能搬过去的是形状(谁占大头、第一次与稳态之比、改动前后
的差)。线上真值看 Workers Logs 的 `cpuTime`。

### 它做了什么(与 perf:cpu 不同的部分)

1. **假上游**(`fake-upstream.mjs`,默认 `127.0.0.1:3399`)。沙箱出网被挡,而这条路每一步都要出网。
   一个 HTTP server 按路径前缀扮演 cron 会打的每一家:binance / okx / bybit / rabby(EVM)/
   coinstats(Solana)/ hyperliquid / blockbook(BTC)/ CoinGecko(`coins/markets`、`simple/price`、
   `coins/list?include_platform=true`、`asset_platforms`、`exchange_rates`、交易所、搜索、历史价)。
   响应形状照录制的 fixture,带上生产响应里我们不读的那些字段(JSON.parse 按字节收费)。
   数据确定性生成,**一个代币宇宙所有上游共用**:CEX 报的 symbol、钱包报的合约地址、CoinGecko 的
   目录与映射表指的是同一批币,mint 才认得出来、估值那段才真的跑。`coins/list` 约 18k 个币、
   23k 条平台地址、2.6 MB,与生产同量级。每个账户约 50 行持仓(bitcoin 单地址只有一行)。
2. worker 经 `dist/server/.dev.vars` 被指到假上游:各家的 base URL 覆盖(`BINANCE_*_BASE` /
   `OKX_API_BASE` / `BYBIT_API_BASE` 是生产本来就有的 #264 开关;`RABBY_API_BASE` /
   `COINSTATS_API_BASE` / `HYPERLIQUID_API_BASE` / `BLOCKBOOK_API_BASE` / `COINGECKO_API_BASE` 是
   FOL-84 补的同款开关,**生产不设**)外加两把假 key(CoinStats 没 key 不出网;CoinGecko 有 key 走
   demo 档的闸,只影响 wall)。你 `.dev.vars` 里就算有真 key,也被这些同名覆盖换掉。
3. 灌的账户带**真形状的凭据**:secret 字段按 app 的规矩用 `SECRETS_KEY` 加密(AES-GCM),worker
   解得开、同步真的会跑,不会在「缺凭据」那一步跳过。
4. 每次调用都**重起 worker**,触发 `/cdn-cgi/handler/scheduled?cron=…`(它等 `waitUntil` 跑完才答,
   所以一次触发 = 一次完整调用)。重起的理由:生产的整点 cron 隔着一小时,多半落在一个没热过这条
   路径的 isolate 上;连着触发的话 JIT、Rabby 的链表缓存、各家的闸都是热的。sweep 每次之前还把代币价
   标成过期(`PRICE_TTL_MS` 30 分钟,生产隔一小时必然过期)。
5. 每个任务先单列一次 **`:first`**(灌完数据后的第一次:目录没缓存 / 代币没建行),
   再量 `--reps` 次稳态(默认 sweep 5、每天那条 3)。映射表是空的就先用 `scripts/ref-index` 刷一次
   (不计时,见上)—— 链上的币靠它认。
6. **队列**:触发之后接着等**这次投的每一条消息**都收尾。条数来自 cron 投完那行日志的 `jobs`
   (`cron sweep enqueued` / `daily jobs enqueued`),收尾来自 consumer 每条一行、带 `kind` 的日志
   (`job done` / `job failed…` / `invalid job dropped`,见 `jobs/consume.ts`);条数收齐之后再等一段
   安静(没有新的 `QUEUE <name> a/b (Nms)` 行 / 收尾行,阈值随 `max_batch_timeout`),接住
   接力投的后续消息(`prices` 拆条、`daily-prices` 补不完再投)。**只靠安静不够**:`platforms` /
   `defi-logos` 延后 120s 才投递,中间整段是安静的 —— 所以一次 sweep 触发本机要两分多钟。
   多出的行:`<任务>:window`(cron + 它引出的全部 consumer 调用,每次触发的总数)与
   `<任务>:queue:<kind>`(每件活的**每次调用**一个样本 —— 免费计划的 10ms 是按一次调用算的)。
   拆法是按时间窗:一次调用的起点 = 看到那行 `QUEUE` 的时刻 − 它自报的耗时,kind 按日志先后配上;
   consumer 并发(`max_concurrency`)时相邻两次会配错,所以逐 kind 是**近似**,总数是准的。
   构建产物里没有 `queues.consumers` → 这些行不出现。

### 怎么读输出

```
   invocation                     n  status   mean … fetches  result                  owners (mean ms/invocation)
!  cron-sweep:first*              1  200      70.0 …     0  synced 8/8, jobs 13/13  Effect … · app code … · D1 driver …
!  cron-sweep                     1  200      86.4 …     0  synced 8/8, jobs 13/13  …
!  cron-sweep:window              1  200     645.5 …     0  synced 8/8, jobs 13/13  …
!  cron-sweep:queue:prices        1  acked    62.1 …     3  1.0 per trigger
!  cron-sweep:queue:sync-account  8  acked    59.0 …     3  8.0 per trigger
```

- **mean / p50 / max** —— 每次调用的采样 CPU(JS + GC),在 n 次之间比。
- **空档样本封顶(与 perf:cpu 唯一的口径差别)**:一次 cron 大半时间在等(闸、上游、D1),isolate
  闲着时采样器是停的,恢复后第一个样本带着整段空档。不封顶的话,一次 sweep 27 秒的窗口里有 21 秒
  落在这种样本上,量到的是等待。所以单个样本最多记 10 × 采样间隔(1ms),超出的记进 summary 的
  `gapMs`。这使 mean 偏向**上界**(每次恢复最多多记不到 1ms);封顶取 2 × 间隔时 sweep 低约 25%。
  `*` 同 perf:cpu:封顶样本贡献了四分之一以上 —— 总数仍可用,但抖动大,多跑几次看 p50。
- **proc** —— 同一段窗口里内核记的 workerd 上 CPU。它含本地 D1(SQLite 在同一个进程里跑,sweep
  写几百行、刷表比对几万行)、HTTP 解析、**以及采样器自己**,所以比 mean 高得多是正常的;它的用处是
  前后对比时看「总量」有没有一起动。
- **wall p50** —— 触发到答的往返。sweep 的 wall 主要是闸在排队(Rabby 每秒 1 发、CoinGecko 每分钟
  80 发),不是 CPU。
- **fetches** —— 这次调用假上游收到几发(按上游 + 路径的明细在 `summary.json` 的 `fetchesByRoute`)。
- **result** —— 从这次调用自己的日志里读出来的:sweep 是 `synced 同步成功/总数`(各轮收官那行
  `queued round done` 相加)+ `jobs 收尾/投出`;每天那条是用户数 + `jobs 收尾/投出`。没干成(有账户
  失败、有消息放弃或超时、没见到投递日志)的状态格会标 `✗`,那行数字作废。逐 kind 那几行的 result
  是「每次触发平均几次这种调用」。
- **owners** —— 同 perf:cpu。

输出目录默认 `.wrangler/perf-state/runs/jobs-<时间戳>/`:每次调用一份 `<任务>-<first|repN>.cpuprofile`、
`summary.json`(逐次的 CPU / gap / 逐路由的出网数 / 收尾日志的字段 / 队列逐批)、`wrangler.log`。

### 局限

- 假上游答得比真上游快、而且从不失败:重试、限流退避那几条路不在数字里。
- bitcoin 只测了单地址(xpub 那条会多派生、多一截 CPU);EVM 只走 Rabby(Zerion 不是默认源)。
- `:first` 在本机是「灌完数据的第一次」,生产上对应的是新用户 / 新币第一次进来那一轮,不是每小时。
- 数据集只有一个用户;多用户的形状(sweep 逐用户串行)要靠 `--accounts` 放大近似。

## 加一个端点

在 `endpoints.mjs` 的 `ENDPOINTS` 里加一行:server fn 写 `fn: "<handler 名>"`(只支持 GET,id 从
构建出的 manifest 按名字反查)+ 需要的话 `data: (ctx) => ({ … })`;文档或普通路由写 `path`。
非 200 的期望状态写 `expect`。

## 线上:`perf:cpu:online`

```sh
CLOUDFLARE_OBSERVABILITY_TOKEN=… pnpm --filter @folio/web perf:cpu:online            # 当前线上版本,最近 7 天
pnpm --filter @folio/web perf:cpu:online --version all --days 1 --token-env MY_VAR  # 所有版本
```

读 Workers Logs 里 Cloudflare 计量的 `cpuTimeMs` —— 线上真值,本地那张表的数字只能拿来比形状。
需要一把**账户级** API token(Manage Account › Account API Tokens,Worker 选 `folio`,角色
Metadata Read-Only);个人 token 加 Workers Observability 权限也读不了日志接口(2026-09 实测)。
`account_id` 与 Worker 名从 `wrangler.jsonc` 读。

- **按调用类型 / cron 的两张表是全量统计**:`exceededCpu` 的次数可以直接引用。
- **按 server fn 的那张是抽样的**:TanStack 的路径在日志里是 `REDACTED`,只能把
  `withServerFnTiming` 打的「server fn」那行(带 `handler`)与同一个 requestId 的调用日志对上,
  而事件接口按自适应采样只回一部分。`n` 就是样本数,别拿它算总量。
- 默认只看**当前线上版本**:换过版本后旧数字不代表现在。新版本刚上线、还没有请求时表是空的。
