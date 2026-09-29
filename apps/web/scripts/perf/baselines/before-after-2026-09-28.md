# FOL-83 免费档 CPU 改造:前后对比(2026-09-28)

- **BEFORE** = `43303c5`(改造前的 main)+ cherry-pick `eb041e6`(只加上游 base URL 的 env 开关,生产不设,行为不变),独立 worktree。
- **AFTER** = `claude/cloudflare-free-tier-optimization-jshxd3` @ `c9c8b59`。
- 两边跑的是**同一份 harness**(本分支的 `scripts/perf/*`,拷进 BEFORE worktree)。为了能量 BEFORE,harness 补了三处兼容,都只影响测量:`dataset.mjs` 在没有 `account_daily_totals` 迁移时跳过日汇总回填(BEFORE 那时没这张表,所以 BEFORE 的 `dailyTotals: null`);`jobs.mjs` 在没有 `enqueued` 日志时按老的 `global ref index refresh done` / `cron sweep done` 判结果;`scripts/ref-index/` 不存在时由 `cron-daily` 在 Worker 里灌映射表(BEFORE 的老路)。灌的数据两边一模一样(同一个 `seedDataset`,同一组确定性 id)。
- 机器:4 核,node v22.22.2,采样间隔 100 µs;同一台机器,BEFORE / AFTER 交替跑,每项至少两轮,表里放**开跑时 load1 更低**的那轮,另一轮的 mean 列在旁边。所有轮次开跑时 load1 都 < 2。
- 口径(见 `README.md`):**mean** = V8 采样到的 CPU(JS + GC),是主数字;**proc** = 内核记的 workerd 进程 CPU(含本地 D1 / SQLite、HTTP 解析、采样器),只作交叉校验;wall 不是 CPU,这里一律不当 CPU 用。
- **本机 CPU ≠ Cloudflare 边缘 CPU**,没有换算系数。能搬过去的是形状和前后差(谁变大 / 变小、差多少比例),不是绝对值。线上真值看 `perf:cpu:online`(Workers Logs 的 `cpuTimeMs`)。

## 1. 读端点(默认数据集:8 账户 / 60 代币 / 30 天逐小时快照)

采用的轮次:BEFORE 第 1 轮(load1 开始 0.11 → 结束 0.84),AFTER 第 1 轮(0.71 → 1.28)。另一轮:BEFORE 第 2 轮(1.09 → 1.02)、AFTER 第 2 轮(1.02 → 1.38)。

| endpoint | BEFORE mean (proc) | AFTER mean (proc) | Δ mean | 另一轮 BEFORE / AFTER mean |
|---|---:|---:|---:|---:|
| doc-root-authed | 0.0 (4.8) | 0.0 (4.6) | — | 0.0 / 0.0 |
| doc-root-anon | 0.0 (4.8) | 0.0 (5.1) | — | 0.0 / 0.0 |
| doc-login | 0.0 (5.2) | 0.0 (4.9) | — | 0.0 / 0.0 |
| auth-get-session | 5.9 (5.7) | 5.0 (5.1) | -15% | 5.5 / 5.6 |
| fn-getSession | 4.3 (4.0) | 4.5 (3.8) | +5% | 4.7 / 4.5 |
| fn-getValuationSettings | 7.7 (7.0) | 7.7 (7.4) | +0% | 6.4 / 8.2 |
| fn-getDataVersion | — | 7.2 (8.1) | — | — / 8.4 |
| fn-listPortfolios | 9.8 (9.3) | 7.0 (7.2) | -29% | 9.6 / 7.7 |
| fn-listAccounts | 15.3 (15.6) | 9.7 (10.4) | -37% | 13.7 / 10.1 |
| fn-getSnapshots-now | 23.2 (17.4) | 13.0 (12.9) | -44% | 17.0 / 11.8 |
| fn-getSnapshots-prev | 16.4 (17.2) | 14.4 (14.3) | -12% | 20.9 / 10.4 |
| fn-getTokenEnrichment | 18.3 (17.0) | 10.9 (11.6) | -40% | 15.8 / 10.8 |
| fn-getFiatRefs | 12.1 (12.5) | 7.8 (9.7) | -36% | 10.4 / 7.3 |
| fn-resolvePlatformMeta | 6.9 (8.7) | 7.6 (7.0) | +10% | 7.6 / 6.6 |
| fn-getPortfolioHistory-30d | 51.5 (48.1) | 12.4 (13.0) | -76% | 48.7 / 10.8 |
| fn-getPortfolioHistory-1y | 28.4 (29.9) | 13.0 (11.9) | -54% | 37.4 / 12.1 |
| fn-listConnectors | 5.8 (5.2) | 4.6 (6.0) | -21% | 5.6 / 5.2 |
| fn-getSyncRound | 6.3 (7.5) | 6.9 (7.4) | +10% | 6.2 / 6.2 |
| fn-getPortfolioTabPins | 6.7 (7.4) | 6.1 (7.1) | -9% | 7.2 / 5.7 |
| fn-listTags | 8.9 (11.0) | 10.1 (7.5) | +13% | 8.7 / 9.6 |
| fn-listAccountTags | 10.8 (10.7) | 8.9 (8.5) | -18% | 11.2 / 9.1 |
| static-favicon | 0.0 (4.1) | 0.0 (5.3) | — | 0.0 / 0.0 |

超 10ms 预算(mean):BEFORE 8/21,AFTER 6/22(`fn-getDataVersion` 是 AFTER 新增的)。**AFTER 仍超预算的**:`fn-getSnapshots-now` / `-prev`、`fn-getTokenEnrichment`、`fn-getPortfolioHistory-30d` / `-1y`,以及贴线的 `fn-listAccounts` / `fn-listTags`(两轮一轮略高于 10、一轮略低)。最大的改动是 `fn-getPortfolioHistory-30d`:≈50 → ≈12 ms。

BEFORE 原表:

```
   endpoint                     status  mean   p50   max  proc  wall p50  owners (mean ms/req)
-  ---------------------------  ------  ----  ----  ----  ----  --------  ----------------------------------------------------------------------------
   doc-root-authed              200      0.0   0.0   0.0   4.8       6.3
   doc-root-anon                200      0.0   0.0   0.0   4.8       5.9
   doc-login                    200      0.0   0.0   0.0   5.2       5.7
   auth-get-session*            200      5.9   5.6  16.2   5.7       5.9  TanStack Start 1.4 · V8 native 1.3 · TanStack Router 1.2 · better-auth 0.8
   fn-getSession*               200      4.3   5.0  11.6   4.0       5.2  TanStack Start 1.9 · V8 native 1.8 · better-auth 0.5 · seroval 0.1
   fn-getValuationSettings*     200      7.7   7.8  15.5   7.0       8.6  TanStack Start 2.2 · V8 native 1.8 · Effect 1.7 · better-auth 0.9
   fn-listPortfolios*           200      9.8  10.3  20.2   9.3      12.0  TanStack Start 2.8 · Effect 2.4 · V8 native 2.0 · better-auth 0.8
!  fn-listAccounts*             200     15.3  15.0  26.5  15.6      18.4  Effect 5.0 · V8 native 3.6 · TanStack Start 2.2 · TanStack Router 1.1
!  fn-getSnapshots-now*         200     23.2  20.7  58.4  17.4      23.7  Effect 7.1 · D1 driver 4.1 · drizzle-orm 3.5 · V8 native 3.2
!  fn-getSnapshots-prev*        200     16.4  16.4  29.0  17.2      20.3  Effect 3.7 · V8 native 3.3 · TanStack Start 3.0 · D1 driver 2.8
!  fn-getTokenEnrichment*       200     18.3  17.3  43.3  17.0      22.7  drizzle-orm 4.1 · Effect 3.8 · V8 native 3.2 · TanStack Start 2.6
!  fn-getFiatRefs*              200     12.1  11.1  23.0  12.5      15.1  Effect 3.2 · V8 native 2.5 · TanStack Start 2.2 · D1 driver 1.4
   fn-resolvePlatformMeta*      200      6.9   6.9  14.1   8.7       9.8  TanStack Start 2.2 · V8 native 1.3 · Effect 1.2 · drizzle-orm 0.6
!  fn-getPortfolioHistory-30d*  200     51.5  51.1  80.0  48.1      67.5  TanStack Start 13.4 · seroval 8.7 · V8 native 8.4 · D1 driver 6.3
!  fn-getPortfolioHistory-1y*   200     28.4  28.8  45.8  29.9      36.6  D1 driver 8.6 · V8 native 3.8 · app code (@folio/*) 3.7 · TanStack Start 3.2
   fn-listConnectors*           200      5.8   5.3  13.9   5.2       6.1  TanStack Start 2.9 · V8 native 1.3 · better-auth 0.6 · Effect 0.6
   fn-getSyncRound*             200      6.3   6.0  34.4   7.5       7.3  TanStack Start 1.7 · V8 native 1.2 · Effect 1.0 · GC 0.6
   fn-getPortfolioTabPins*      200      6.7   6.6  18.6   7.4       8.3  Effect 1.5 · TanStack Start 1.4 · V8 native 1.3 · TanStack Router 0.5
   fn-listTags*                 200      8.9   9.1  16.3  11.0      10.9  Effect 2.2 · TanStack Start 2.1 · V8 native 1.7 · drizzle-orm 0.7
!  fn-listAccountTags*          200     10.8  10.6  17.2  10.7      12.3  Effect 3.1 · TanStack Start 3.0 · V8 native 1.4 · D1 driver 0.8
   static-favicon               200      0.0   0.0   0.0   4.1       4.5
```

AFTER 原表:

```
   endpoint                     status  mean   p50   max  proc  wall p50  owners (mean ms/req)
-  ---------------------------  ------  ----  ----  ----  ----  --------  -----------------------------------------------------------------------------------
   doc-root-authed              200      0.0   0.0   0.0   4.6       5.7
   doc-root-anon                200      0.0   0.0   0.0   5.1       6.2
   doc-login                    200      0.0   0.0   0.0   4.9       5.5
   auth-get-session*            200      5.0   5.2  13.1   5.1       5.7  TanStack Start 1.4 · V8 native 1.3 · better-auth 0.8 · TanStack Router 0.5
   fn-getSession*               200      4.5   4.6  11.2   3.8       4.9  TanStack Start 2.0 · V8 native 1.1 · better-auth 0.6 · TanStack Router 0.4
   fn-getValuationSettings*     200      7.7   8.0  10.7   7.4       8.5  TanStack Start 1.9 · Effect 1.6 · V8 native 1.3 · TanStack Router 0.6
   fn-getDataVersion*           200      7.2   8.0  12.2   8.1       8.6  TanStack Start 2.9 · Effect 1.3 · V8 native 1.2 · better-auth 0.7
   fn-listPortfolios*           200      7.0   7.7  10.9   7.2       8.8  TanStack Start 2.5 · V8 native 1.8 · Effect 1.1 · better-auth 0.5
   fn-listAccounts*             200      9.7  10.0  17.0  10.4      11.9  Effect 2.4 · TanStack Start 2.3 · V8 native 2.2 · D1 driver 1.0
!  fn-getSnapshots-now*         200     13.0  12.4  20.7  12.9      14.4  V8 native 3.3 · TanStack Start 2.5 · D1 driver 2.4 · Effect 1.6
!  fn-getSnapshots-prev*        200     14.4  14.7  24.1  14.3      16.7  V8 native 4.2 · Effect 2.9 · D1 driver 2.4 · TanStack Start 1.5
!  fn-getTokenEnrichment*       200     10.9  10.3  22.4  11.6      14.1  V8 native 3.0 · Effect 2.1 · TanStack Start 1.7 · drizzle-orm 1.2
   fn-getFiatRefs*              200      7.8   8.6  13.3   9.7       9.9  TanStack Start 2.7 · V8 native 1.6 · Effect 1.3 · D1 driver 0.9
   fn-resolvePlatformMeta*      200      7.6   7.8  18.5   7.0       8.3  TanStack Start 2.6 · V8 native 1.8 · Effect 1.0 · better-auth 0.5
!  fn-getPortfolioHistory-30d*  200     12.4  11.9  20.3  13.0      14.0  V8 native 3.0 · TanStack Start 2.2 · D1 driver 2.1 · Effect 1.9
!  fn-getPortfolioHistory-1y*   200     13.0  12.1  22.4  11.9      15.1  V8 native 3.8 · Effect 2.6 · D1 driver 2.2 · TanStack Start 1.3
   fn-listConnectors*           200      4.6   4.8  16.1   6.0       5.9  TanStack Start 2.2 · vendor: @logtape/logtape 0.8 · V8 native 0.6 · better-auth 0.5
   fn-getSyncRound*             200      6.9   6.7  21.1   7.4       7.6  TanStack Start 1.7 · V8 native 1.3 · Effect 1.0 · app code (@folio/*) 0.8
   fn-getPortfolioTabPins*      200      6.1   6.5  10.2   7.1       6.9  TanStack Start 1.9 · V8 native 1.5 · Effect 1.0 · TanStack Router 0.4
!  fn-listTags*                 200     10.1   8.8  18.1   7.5       9.8  TanStack Start 2.9 · V8 native 2.0 · Effect 1.6 · D1 driver 1.2
   fn-listAccountTags*          200      8.9   8.9  19.3   8.5      10.5  TanStack Start 2.0 · V8 native 1.5 · Effect 1.5 · app code (@folio/*) 0.7
   static-favicon               200      0.0   0.0   0.0   5.3       4.9
```

## 2. 长历史(365 天 / 10 账户 / 50 代币,约 8.8 万张快照、73.6 万行持仓)

采用的轮次:BEFORE 第 1 轮(load1 1.27 → 1.29),AFTER 第 1 轮(1.17 → 1.02)。另一轮:BEFORE 第 2 轮(1.02 → 1.13),AFTER 第 2 轮(1.13 → 1.07)。AFTER 灌了 3660 行日汇总(`account_daily_totals`),BEFORE 没这张表。

| endpoint | BEFORE mean (proc) | AFTER mean (proc) | Δ mean | 另一轮 BEFORE / AFTER mean |
|---|---:|---:|---:|---:|
| fn-getSnapshots-now | 20.9 (17.3) | 13.7 (12.8) | -34% | 16.5 / 14.0 |
| fn-getSnapshots-prev | 18.7 (16.7) | 13.0 (12.6) | -30% | 17.1 / 11.5 |
| fn-getPortfolioHistory-30d | 139.3 (155.1) | 12.5 (13.4) | -91% | 131.5 / 12.6 |
| fn-getPortfolioHistory-1y | 271.6 (316.7) | 20.6 (23.7) | -92% | 271.7 / 20.1 |

曲线随表长不再线性长:1 年窗口 ≈272 → ≈20 ms,30 天窗口 ≈135 → ≈12.5 ms。四个端点在 AFTER 上仍都略超 10ms(本机数)。

BEFORE 原表:

```
   endpoint                     status   mean    p50    max   proc  wall p50  owners (mean ms/req)
-  ---------------------------  ------  -----  -----  -----  -----  --------  --------------------------------------------------------------------------------
!  fn-getSnapshots-now*         200      20.9   20.3   35.9   17.3      24.1  Effect 4.3 · TanStack Start 3.4 · D1 driver 3.3 · V8 native 3.2
!  fn-getSnapshots-prev*        200      18.7   17.7   30.2   16.7      20.6  Effect 4.5 · V8 native 4.0 · drizzle-orm 2.6 · TanStack Start 2.6
!  fn-getPortfolioHistory-30d*  200     139.3  167.5  236.5  155.1     183.0  D1 driver 52.9 · app code (@folio/*) 38.8 · TanStack Start 13.8 · V8 native 11.0
!  fn-getPortfolioHistory-1y*   200     271.6  302.0  366.8  316.7     315.5  D1 driver 135.9 · app code (@folio/*) 55.9 · drizzle-orm 29.3 · GC 19.7
```

AFTER 原表:

```
   endpoint                     status  mean   p50   max  proc  wall p50  owners (mean ms/req)
-  ---------------------------  ------  ----  ----  ----  ----  --------  ----------------------------------------------------------------
!  fn-getSnapshots-now*         200     13.7  14.3  23.2  12.8      15.8  V8 native 4.7 · Effect 2.4 · TanStack Start 2.2 · D1 driver 1.9
!  fn-getSnapshots-prev*        200     13.0  12.9  20.9  12.6      15.9  V8 native 4.1 · TanStack Start 2.3 · D1 driver 2.2 · Effect 1.8
!  fn-getPortfolioHistory-30d*  200     12.5  12.9  25.8  13.4      15.0  V8 native 2.5 · Effect 2.1 · TanStack Start 2.0 · D1 driver 1.8
!  fn-getPortfolioHistory-1y*   200     20.6  21.1  31.6  23.7      27.5  D1 driver 10.1 · V8 native 3.0 · TanStack Start 2.8 · Effect 2.0
```

## 3. 后台(cron + 队列),每次调用一个样本,每次都重起 worker

采用的轮次:BEFORE 第 2 轮(load1 0.21 → 0.47),AFTER 第 1 轮(0.39 → 0.19)。另一轮原表放在本节末尾。

### 3.1 BEFORE:一次 cron 调用干完全部活

```
   invocation         n  status    mean     p50     max     proc  wall p50  fetches  result                                     owners (mean ms/invocation)
-  -----------------  -  ------  ------  ------  ------  -------  --------  -------  -----------------------------------------  -------------------------------------------------------------------------------
!  cron-daily:first   1  200      620.8   620.8   620.8   1450.4     986.9        2  legacy: ref index rows 12093 +12093/~0/-0  Effect 350.4 · drizzle-orm 165.8 · app code (@folio/*) 43.2 · GC 31.5
!  cron-daily         3  200      456.1   454.2   465.3    887.0     633.0        2  legacy: ref index rows 12093 +0/~0/-0      Effect 341.6 · app code (@folio/*) 52.8 · GC 30.3 · drizzle-orm 15.9
!  cron-sweep:first*  1  200     3947.3  3947.3  3947.3  12987.6   42352.6       83  legacy: synced 8/8                         Effect 2014.9 · app code (@folio/*) 492.0 · D1 driver 475.4 · drizzle-orm 422.8
!  cron-sweep*        5  200      744.4   749.8   759.0   6135.6   27426.2       63  legacy: synced 8/8                         Effect 426.1 · drizzle-orm 94.6 · app code (@folio/*) 93.1 · V8 native 57.4
```

- `30 * * * *`(整点 sweep):稳态 mean 744 ms / max 759 ms,每次调用打上游 63 发(第一次 83 发)。**6/6 次调用超 10ms。**
- `0 23 * * *`(每天那条:剪 notes + 在 Worker 里刷全局映射表):稳态 mean 456 ms / max 465 ms,每次 2 发。**4/4 次超 10ms。**

### 3.2 AFTER:cron 只投活,活在队列 consumer 里一条一次调用

```
   invocation                      n  status   mean    p50    max     proc  wall p50  fetches  result                  owners (mean ms/invocation)
-  -----------------------------  --  ------  -----  -----  -----  -------  --------  -------  ----------------------  -------------------------------------------------------------------------------
!  cron-daily:first                1  200      65.0   65.0   65.0   1683.0      80.8        0  users 1, jobs 2/2       Effect 111.0 · app code (@folio/*) 14.2 · drizzle-orm 9.9 · GC 6.3
!  cron-daily                      3  200      60.9   62.5   63.3   1308.5      73.9        0  users 1, jobs 2/2       Effect 56.0 · app code (@folio/*) 9.2 · drizzle-orm 7.6 · GC 6.5
!  cron-daily:window               3  200      88.3   90.2   91.5   1308.5      73.9        0  users 1, jobs 2/2       Effect 56.0 · app code (@folio/*) 9.2 · drizzle-orm 7.6 · GC 6.5
   cron-daily:queue:catalogue      3  acked     0.0    0.0    0.0        —      25.0        0  1.0 per trigger
!  cron-daily:queue:prune-notes    3  acked    27.4   27.8   28.3        —      76.0        0  1.0 per trigger
!  cron-sweep:first*               1  200      70.3   70.3   70.3  27724.2      95.0        0  synced 8/8, jobs 13/13  Effect 1711.9 · app code (@folio/*) 468.8 · D1 driver 439.6 · drizzle-orm 377.5
!  cron-sweep                      5  200     104.2  111.5  113.7  23417.5      99.5        0  synced 8/8, jobs 13/13  Effect 316.4 · drizzle-orm 90.9 · app code (@folio/*) 85.9 · V8 native 40.1
!  cron-sweep:window               5  200     603.5  599.6  630.4  23417.5      99.5        0  synced 8/8, jobs 13/13  Effect 316.4 · drizzle-orm 90.9 · app code (@folio/*) 85.9 · V8 native 40.1
   cron-sweep:queue:daily-prices   5  acked     4.1    1.0   18.1        —       4.0        0  1.0 per trigger
   cron-sweep:queue:defi-logos     5  acked     0.2    0.0    0.9        —      15.0        0  1.0 per trigger
!  cron-sweep:queue:fx             5  acked    21.7   24.8   32.5        —     706.0        1  1.0 per trigger
   cron-sweep:queue:platforms      5  acked     2.5    0.0    6.7        —      20.0        0  1.0 per trigger
!  cron-sweep:queue:prices         5  acked    67.2   66.0   75.7        —     860.0        3  1.0 per trigger
!  cron-sweep:queue:sync-account  40  acked    50.5   42.8  149.2        —      68.5        3  8.0 per trigger
```

按调用汇总(稳态 5 次 sweep + 3 次 daily;逐 kind 按日志时间窗拆分,是近似,总数准):

| 调用 | 次数 | mean CPU | max CPU | 上游请求 / 次 | 超 10ms 的次数 |
|---|---:|---:|---:|---:|---:|
| cron `30 * * * *`(开轮 + 投 13 条) | 5(+1 first) | 104.2 | 113.7 | 0 | 6/6 |
| cron `0 23 * * *`(投 2 条) | 3(+1 first) | 60.9 | 63.3 | 0 | 4/4 |
| queue `sync-account` | 40 | 50.5 | 149.2 | 3 | 40/40 |
| queue `prices` | 5 | 67.2 | 75.7 | 3 | 5/5 |
| queue `fx` | 5 | 21.7 | 32.5 | 1 | 4/5 |
| queue `daily-prices` | 5 | 4.1 | 18.1 | 0 | 1/5 |
| queue `platforms` | 5 | 2.5 | 6.7 | 0 | 0/5 |
| queue `defi-logos` | 5 | 0.2 | 0.9 | 0 | 0/5 |
| queue `prune-notes` | 3 | 27.4 | 28.3 | 0 | 3/3 |
| queue `catalogue` | 3 | 0.0 | 0.0 | 0 | 0/3 |

- 一次 sweep 触发引出的全部调用(`cron-sweep:window`):mean 603.5 ms,上游共 29 发(BEFORE 一次 cron 是 63 发)。总 CPU 只比 BEFORE 的 744 ms 少约两成 —— 省下的主要不是总量,而是**把一次 744 ms 拆成了 14 次调用**。
- 另一轮 AFTER(第 2 轮)的超预算次数:sync-account 40/40,prices 5/5,fx 3/5,daily-prices 1/5,platforms 1/5(max 15.9),defi-logos 0/5,prune-notes 3/3,catalogue 0/3;两个 cron 本体全部超。
- `catalogue` 两轮都是 0 ms、0 发:目录缓存(7 天)在灌完数据后是新的,这一格量的是「命中缓存直接返回」,不是真刷目录。
- `cron-*` 两行的 owners 列是整个窗口(cron + 队列)的归属,不是 cron 那一次的。

**关键问题:AFTER 还有没有单次 Worker 调用超 10ms(本机)?有,而且是大多数:**

1. `sync-account`(每账户每小时一次):mean ≈50 ms,max 149–173 ms —— 最大的一块,也是次数最多的。
2. `prices`:≈60–67 ms。
3. 整点 cron 本体(只开轮 + 投 13 条消息):≈90–104 ms。每次都是新 isolate,这个数含首调初始化(服务图、Effect 运行时首跑);生产的整点 cron 多半也落在冷 isolate 上,所以这不算冤枉它。
4. 每天那条 cron 本体(只投 2 条):≈60 ms,同上。
5. `prune-notes`:≈27–32 ms。
6. `fx`:≈14–22 ms(大多数次超)。
7. 偶发:`daily-prices`(max 18–24 ms,5 次里 1 次)、`platforms`(第 2 轮 max 15.9 ms)。

低于 10ms 的只有 `defi-logos`、`catalogue`(命中缓存)、`platforms` / `daily-prices` 的多数次。

### 3.3 映射表刷新(FOL-85 挪出 Worker)

AFTER 用 `scripts/ref-index/refresh.ts --local` 在 Node 里刷(harness 灌完数据后跑一次):12093 行,插入 12093,2 次读、605 条语句 13 批,**墙钟 2.8 s(Node 进程,不是 Worker CPU)**。BEFORE 同一件事在 Worker 的 `0 23 * * *` 里:第一次 620.8 ms、稳态 456 ms 采样 CPU(见 3.1)。

### 3.4 另一轮原表

BEFORE 第 1 轮(load1 0.98 → 0.42):

```
   invocation         n  status    mean     p50     max     proc  wall p50  fetches  result                                     owners (mean ms/invocation)
-  -----------------  -  ------  ------  ------  ------  -------  --------  -------  -----------------------------------------  -------------------------------------------------------------------------------
!  cron-daily:first   1  200      613.2   613.2   613.2   1430.3    1093.1        2  legacy: ref index rows 12093 +12093/~0/-0  Effect 337.7 · drizzle-orm 171.5 · app code (@folio/*) 38.0 · D1 driver 28.4
!  cron-daily         3  200      414.0   387.4   468.7    851.9     594.7        2  legacy: ref index rows 12093 +0/~0/-0      Effect 313.1 · app code (@folio/*) 51.1 · GC 21.2 · drizzle-orm 15.1
!  cron-sweep:first*  1  200     3843.5  3843.5  3843.5  12818.1   42298.4       83  legacy: synced 8/8                         Effect 1948.1 · app code (@folio/*) 531.1 · D1 driver 468.4 · drizzle-orm 392.5
!  cron-sweep*        5  200      750.5   751.9   777.2   6177.0   27427.7       63  legacy: synced 8/8                         Effect 427.8 · drizzle-orm 95.1 · app code (@folio/*) 92.4 · V8 native 62.9
```

AFTER 第 2 轮(load1 0.47 → 0.21):

```
   invocation                      n  status   mean    p50    max     proc  wall p50  fetches  result                  owners (mean ms/invocation)
-  -----------------------------  --  ------  -----  -----  -----  -------  --------  -------  ----------------------  -------------------------------------------------------------------------------
!  cron-daily:first                1  200      56.0   56.0   56.0   1678.8      73.0        0  users 1, jobs 2/2       Effect 105.1 · app code (@folio/*) 16.9 · drizzle-orm 8.1 · GC 7.5
!  cron-daily                      3  200      59.1   59.2   59.3   1330.6      75.5        0  users 1, jobs 2/2       Effect 54.7 · app code (@folio/*) 10.8 · GC 8.0 · drizzle-orm 7.1
!  cron-daily:window               3  200      90.8   89.0   95.9   1330.6      75.5        0  users 1, jobs 2/2       Effect 54.7 · app code (@folio/*) 10.8 · GC 8.0 · drizzle-orm 7.1
   cron-daily:queue:catalogue      3  acked     0.0    0.0    0.0        —      29.0        0  1.0 per trigger
!  cron-daily:queue:prune-notes    3  acked    31.7   30.2   36.6        —      77.0        0  1.0 per trigger
!  cron-sweep:first*               1  200      93.3   93.3   93.3  27480.5     102.3        0  synced 8/8, jobs 13/13  Effect 1750.5 · app code (@folio/*) 510.9 · D1 driver 488.3 · drizzle-orm 416.3
!  cron-sweep                      5  200      89.8   83.6  114.1  23590.8      95.9        0  synced 8/8, jobs 13/13  Effect 325.8 · drizzle-orm 88.9 · app code (@folio/*) 87.4 · V8 native 42.7
!  cron-sweep:window               5  200     615.8  621.1  638.5  23590.8      95.9        0  synced 8/8, jobs 13/13  Effect 325.8 · drizzle-orm 88.9 · app code (@folio/*) 87.4 · V8 native 42.7
   cron-sweep:queue:daily-prices   5  acked     4.8    0.0   24.0        —       4.0        0  1.0 per trigger
   cron-sweep:queue:defi-logos     5  acked     3.1    1.3    9.8        —      16.0        0  1.0 per trigger
!  cron-sweep:queue:fx             5  acked    14.2   17.2   26.8        —     699.0        1  1.0 per trigger
   cron-sweep:queue:platforms      5  acked     4.7    1.8   15.9        —      20.0        0  1.0 per trigger
!  cron-sweep:queue:prices         5  acked    59.8   57.9   71.8        —     866.0        3  1.0 per trigger
!  cron-sweep:queue:sync-account  40  acked    54.9   44.8  173.4        —      63.5        3  8.0 per trigger
```

## 4. 开一次页面发多少请求(Playwright Chromium)

`scripts/perf/requests.mjs`:同一个构建产物 + perf 库 + 假上游,登录后在新上下文打开 `/`(冷开),等网络静下来,再 `reload()`(数据没变)。计数取**服务端那一侧**(wrangler dev 每个进来的请求一行),即真进了 Worker 的条数;浏览器侧计数在 `summary.json` 里对照。两边都跑了两轮,数字几乎一样,下面是第 2 轮(logo 条数两轮间有几条浮动,因为 logo 按视口懒加载)。

| | serverFn | /api(非 logo) | /api/logo |
|---|---:|---:|---:|
| BEFORE 冷开 | 30 | 0 | 54 |
| AFTER 冷开 | 31 | 0 | 43 |
| BEFORE 刷新(数据没变) | 16 | 0 | 61 |
| AFTER 刷新(数据没变) | 3 | 0 | 40 |

第 1 轮:BEFORE 冷开 30 / 0 / 63,刷新 16 / 0 / 62;AFTER 冷开 29 / 0 / 43,刷新 3 / 0 / 40(serverFn / api / logo)。

- **冷开两边都加载了两次文档**(主帧导航 3 次:打开、SW 安装后页面自己刷一次),所以冷开的 serverFn 数是「两次页面加载」的和:每次约 15 条,两边一样。这是现有 app 的行为,两边一致,没深挖。
- **刷新**:BEFORE 16 条 serverFn(全部查询重取),AFTER 3 条(`getSession` / `getDataVersion` / `getSyncRound`)—— IndexedDB 里的查询缓存 + 数据版本没变就不重取(FOL-94)。
- logo:AFTER 冷开 43 条(两次加载合计)对 BEFORE 54–63 条;刷新时 AFTER 40 条对 BEFORE 61–62 条。刷新时 logo 仍然进 Worker(浏览器没从 HTTP 缓存答);AFTER 的 logo 在边缘有缓存(FOL-93),本地 wrangler dev 看不出边缘缓存的效果。
- 浏览器:沙箱里只有 Chromium 141(`/opt/pw-browsers` 的 1194 版),Playwright 1.62 要的是 1234 版;用 scratch 目录里的符号链接把 1194 当 1234 用,没跑 `playwright install`。

## 5. e2e(AFTER,按 CI 的步骤:`db:migrate:e2e` → `CLOUDFLARE_ENV=test build` → `test:e2e`,`CI=true`)

**79 过、3 挂**(8.8 分钟,每条挂的都重试过一次,仍挂)。挂的三条都在 `e2e/sync-round.spec.ts` 的「面板读轮」里:

| 测试 | 错误 |
|---|---|
| `sync-round.spec.ts:245` 缺凭据的账户算「需要凭据」,不算失败 | `expect(getByText('1 need keys')).toBeVisible()` —— element(s) not found(30s 超时) |
| `sync-round.spec.ts:263` 整轮没跑起来 → 报错,不谎报成功 | `expect(getByText('Failed this round')).toBeVisible()` —— element(s) not found |
| `sync-round.spec.ts:283` 中断的一轮 → 说出来,不装作没事 | `expect(getByText('stopped partway')).toBeVisible()` —— element(s) not found |

- 在 AFTER 上单独重跑这个 spec:同样 3 挂 3 过 —— 必挂,不是偶挂。
- 在 BEFORE 上跑同一个 spec(同样 test 环境构建):**6/6 全过**。所以这是 AFTER 引入的回归(或测试没跟上改动),不是环境问题。
- 现象(看 error-context 的页面快照):胶囊先变成 mock 的「Needs attention」,悬停面板里却是「All synced · This round 1 synced」,胶囊也回到了「Synced」。三条测试都是把 `POST /api/sync` 的回包换成假的一轮;看起来面板 / 胶囊之后又从服务端读了真实的这一轮(可能与 FOL-89「手动同步只投活就返回」或 FOL-94 的数据版本重取有关)—— **这是推测,没验证**,按要求没改 app 代码。
- 日志里还有一条 workerd 报的 `Disallowed operation called within global scope`(全局作用域里做了异步 I/O / 定时器 / 随机数),没有让测试挂,没深挖。

## 6. 局限

- 本机数字 ≠ 边缘数字;假上游答得快、从不失败,重试 / 限流退避不在数里。
- jobs 每次调用都重起 worker(模拟整点落在冷 isolate),所以两个 cron 本体的数含首调初始化;同一 isolate 里接着跑的 consumer 调用是半热的。
- 逐 kind 的队列数按日志时间窗拆,consumer 并发时可能配错到相邻一次;整个窗口的总数是准的。
- `proc` 含本地 D1 与采样器自身;jobs 表里 AFTER 的 proc(2 万多 ms)主要是两分多钟窗口里采样器空转,不要拿它和 BEFORE 的 proc 直接比。

---

# 第二轮(FOL-83 round 2,同日)

- **AFTER r2** = 本分支 `e546d55..a6e4049`(接在 `6c9ac75` 之后)。**BEFORE / AFTER r1** 两列照抄上面第 1、3 节(同一台机器、同一份 harness 口径)。
- 同一台 4 核机器;每张表注明开跑时的 load1。另一个会话在同机跑 e2e,所以我只在 load1 < 2 时开跑,较忙的那轮单独标出。
- 第二轮给 harness 加了三样(只影响测量):每份 profile 旁存每次调用的时间窗(`*.slots.json`)与那次构建的 region 表,`perf:cpu:analyze` 据此出**函数级**的 self / inclusive / 调用树;`--warm`(同一 isolate 连着跑);`--cron-only`(只量 `scheduled()`,worker 不带 consumer —— 默认口径下 cron 那一格的起止靠日志估,consumer 的开头常被算进 cron,**比 cron 本体看 `--cron-only` 那两行**)。另外修了假上游:`exchange_rates` 原来只有 6 种法币,`fx.warm()` 每次都判「缺」而回源,所以第一轮表里的 `fx`(1 发、14–22ms)量的是「每小时真刷一次」,生产上是 6h TTL 内的缓存命中。

## 1. profile 说了什么(函数级)

- **冷 isolate 上最大的一块是建服务图本身。** 每天那个 cron 本体 57ms 里约 45ms 落在 `runAtEdge → ManagedRuntime` 的构建上(timeline:前 45ms 是 `synchronizedRef`/memo 表/`fiberRefs` 与各服务构造,第一条 D1 查询在 45ms 之后才出现);`--warm` 下同一件事只要约 7ms。Node 冷进程对照:`ManagedRuntime.make(Layer.mergeAll(两张 db 门票 + 日志))` 20ms,手搭 `Runtime.make` 4.5ms;参考层那半单独经 Layer 建 35–40ms。**钱在 Layer 的构建机器上,不在服务上。**
- **`prices`**:`tokenPrices.put` 一币一条 drizzle `UPDATE`,拼语句(`entity.is` 10ms self、`buildQueryFromSourceParams`、`buildUpdateSet`)约 20ms。
- **`catalogue`**:为了判「一周内新不新」把 1000 行目录整份过 Schema:解码约 9ms + GC 约 7ms。
- **交易所 `sync-account`**:币安那一次里 `fmtAmount`(`toLocaleString`)约 15–19ms —— 其实是 **ICU 在 isolate 里第一次初始化数字格式**(Node 冷进程:第一次 `new Intl.NumberFormat` 15ms,之后六次 0.07ms)。
- **`sync-account` 其余**:平均 ~50ms 里能认出来的块是上游响应的 Schema 解码(~7–8ms,大头是 `NullOr`/`optional` 的 union 分支)、drizzle 拼语句 + D1 驱动(~8–10ms)、每条消息一遍的五层 `Layer.mergeAll`(`makeSyncServicesLayer`)与单账户也走的 `Stream` 机器;**剩下一半以上是 Effect 运行时本身**(`runLoop` / `fiberRefs` / `Equal` / span),摊在几百个小 effect 上,没有单个热点。
- 读端点没有新热点:~4–5ms 是 TanStack Start + better-auth 的每请求底座,Effect ~1.5–2.5ms,其余是 D1 行转换与业务。

## 2. 杠杆与各自的量(本机)

| 提交 | 改了什么 | 量到的 |
|---|---|---|
| `7a2000c` | 服务图不经 `ManagedRuntime`/Layer 建:db 门票 + 日志直接 `Runtime.make`(cron / 剪 note / 边缘只用它);参考层一次 `runSync(buildWithScope)` 补上 | `--cron-only`:每天 cron 本体 53.7 → 17.7ms,每小时 72.2 → 38.5ms |
| `20a39e2` | 一批价一条 `UPDATE tokens … FROM json_each(?)` | `prices` 66.1 → 38.9ms |
| `abbadf9` | `sync-account`:服务造成 `Context` 直接给(不经 Layer)、`Sweep.syncOne` 不经 Stream、mint 已认出的行不再各起一段 `Effect.gen` | 连同 Intl 那条:sync-account p50 40.0 → 35.5ms,整点窗口 615 → 555ms |
| `34a6f80` → `b2beac0` | note 数字格式:先是复用 formatter(几乎没省,第一版判断错了),再改成不碰 Intl 的纯函数(与 `toLocaleString` 逐字相同,3000 个随机数 + 边界对照测) | 省掉每个 isolate 第一次交易所同步的 ICU 初始化(≈15ms,只在冷 isolate 上出现,均值里被摊薄) |
| `34f3d8c` | `catalogue` 先看 blob 自己的 `asOf`,够新就不解码整份目录 | 每天那一窗(cron + 两条消息)86.3 → 75.9ms |

## 3. 后台:每次调用的 CPU(mean / max,ms)

AFTER r2 = `final1`(`perf:cpu:jobs` 默认口径,sweep 5 次 + daily 3 次,每次新起 worker;开跑 load1 1.16 → 结束 0.48)。`--cron-only` 两行另跑(第二轮:load1 0.90 与 1.73 两轮;第一轮代码:0.22)。

| 调用 | BEFORE | AFTER r1 | AFTER r2 | 超 10ms? |
|---|---|---|---|---|
| cron `30 * * * *` 本体,`--cron-only` | (一次调用干完全部:744 / 759) | 72.2 / 76.7 | **38.5 / 41.2**(另一轮 38.4 / 42.8) | 超 |
| cron `0 23 * * *` 本体,`--cron-only` | (干完全部:456 / 465) | 53.7 / 60.2 | **17.7 / 21.2**(另一轮 14.9 / 18.8) | 超 |
| cron 整点,默认口径(含 consumer 溢进来的开头) | 744 / 759 | 104.2 / 113.7 | 68.6 / 87.9 | 超 |
| cron 每天,默认口径 | 456 / 465 | 60.9 / 63.3 | 22.2 / 23.6 | 超 |
| queue `sync-account`(40 次) | — | 50.5 / 149.2 | 49.2 / 175.7(p50 42.8 → 39.9) | 超 |
| queue `prices` | — | 67.2 / 75.7 | **39.9 / 58.0** | 超 |
| queue `fx` | — | 21.7 / 32.5(假上游缺币种,每次真刷) | 14.2 / 19.8(0 发) | 超(见下) |
| queue `daily-prices` | — | 4.1 / 18.1 | 0.9 / 4.0 | 否 |
| queue `platforms` | — | 2.5 / 6.7 | 4.5 / 13.6 | 偶发 |
| queue `defi-logos` | — | 0.2 / 0.9 | 1.9 / 5.7 | 否 |
| queue `prune-notes` | — | 27.4 / 28.3 | 20.2 / 21.4 | 超 |
| queue `catalogue` | — | 0.0 / 0.0(拆分错配,见下) | 29.3 / 30.2 | 超 |
| **整点一窗合计**(cron + 13 次 consumer) | 744 | 603.5 | **523.8** / 538.6 | — |
| **每天一窗合计**(cron + 2 次 consumer) | 456 | 88.3 | **71.7** / 72.3 | — |

逐 kind 的数按日志时间窗拆,consumer 串行时相邻两次会互相配错(第一轮 `catalogue` 0.0 / `prune-notes` 27 就是这样:目录解码那 20ms 被记到了 `prune-notes` 头上),**两个「一窗合计」是准的**。第二轮之后参考层那半的冷构建(本机约 20ms)落在 isolate 里第一条要它的消息上 —— 整点那一窗是第一条 `sync-account`(max 175.7 就是它),每天那一窗是 `catalogue`(29.3 里大半是它)。

## 4. 读端点(默认数据集,30 发 / 端点,mean ms)

AFTER r2 = `read1`(load1 0.43,开跑在第一条杠杆之后,后面几条不碰读路径);括号里是 `read2`(全部提交之后,load1 1.43)。

| endpoint | BEFORE | AFTER r1 | AFTER r2 |
|---|---:|---:|---:|
| fn-listAccounts | 15.3 | 9.7 | 10.1 (9.4) |
| fn-getSnapshots-now | 23.2 | 13.0 | 11.8 (13.1) |
| fn-getSnapshots-prev | 16.4 | 14.4 | 11.1 (13.2) |
| fn-getTokenEnrichment | 18.3 | 10.9 | 11.5 (12.5) |
| fn-getPortfolioHistory-30d | 51.5 | 12.4 | 10.3 (11.5) |
| fn-getPortfolioHistory-1y | 28.4 | 13.0 | 10.9 (12.2) |
| fn-listTags | 8.9 | 10.1 | 9.5 (8.5) |
| fn-listAccountTags | 10.8 | 8.9 | 9.1 (9.0) |
| fn-getFiatRefs | 12.1 | 7.8 | 8.6 (7.8) |
| 其余(getValuationSettings / getDataVersion / listPortfolios / getSyncRound / tabPins / listConnectors / getSession / auth) | 4–10 | 4.6–7.7 | 3.8–7.8 |

读路径第二轮没有专门的杠杆:它早已跑在热的 isolate 运行时上,新的构建方式只影响冷的第一发。差值在两轮之间的噪声以内(`read2` 那轮机器更忙)。

## 5. 仍超 10ms 的,以及为什么

**直说:目标(每种后台调用本机 mean < 10ms)没有达到。** 达到的只有 `daily-prices` / `defi-logos` / 多数次的 `platforms`,以及读端点里原本就不超的那些。

1. **`sync-account`(~40–50ms,次数最多)**:一个账户的同步是「取余额(1–3 发上游)→ 校验响应 → 认币 → 重估 → 写一张 ~50 行的快照 + 日汇总」,十几条 D1 语句、几百个小 effect。能认出来的块(上游 Schema 解码 ~7ms、drizzle + D1 驱动 ~10ms)各自都比 10ms 小,**剩下一半以上是 Effect 运行时本身**,分散、没有单个热点(profile 见 `perf:cpu:analyze --kind sync-account`)。再往下要么把同步内核从 Effect 里拿出来,要么把一个账户拆成几条消息 —— 两者都是架构决定,不在本轮。
2. **cron 本体(每天 ~15–18ms、整点 ~38ms,`--cron-only`)**:服务图的构建已经从 ~45ms 降到 ~4ms,剩下的是冷 isolate 上**第一次**跑 Effect / drizzle / LogTape 的代价(整点那条要 8 条不同形状的 D1 语句,每一种第一次拼都是冷代码;`--warm` 下每天那条只要 ~7ms)。
3. **`prices`(~40ms)**:写价已经是一条语句;剩下的是读最新快照(8 账户 × ~50 行 → JS 对象)、按持仓算 id、两次 store 读、两发上游的解码,外加这一 isolate 里可能是第一次用到的参考层代码。
4. **`catalogue` / `prune-notes`(~20–30ms)**:本身的活已经很小(目录够新就只看 `asOf`;剪 note 是四条语句),数字里主要是冷 isolate 的首跑与参考层那 ~20ms 的构建(`catalogue` 是这一窗里第一条要参考层的消息)。
5. **`fx`(~14ms,0 发)**:一次批量缓存读、判新鲜、返回;数字大半是冷的首跑,且与相邻调用的拆分有误差。
6. **读端点 getSnapshots / getTokenEnrichment / history(~10–13ms)**:其中 ~4–5ms 是每请求的框架底座(TanStack Start 的 server-fn 解析 + better-auth 认 cookie),Effect ~2ms,其余是 D1 行转换与序列化;本轮没有找到不改行为就能去掉的块。

**还没试、但量上最大的一条**:把 isolate 那张图挪到模块顶层建(Workers 的启动 CPU 另算预算)。它是把钱挪去启动预算而不是省掉,且与「模块加载期什么都不跑」的约定冲突,记在 ADR 0054 第二轮补记的「否决」里,留给以后决定。
