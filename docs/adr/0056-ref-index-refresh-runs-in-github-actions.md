# 0056 — 全局映射表改由 GitHub Actions 刷,经 D1 REST API 写库

日期:2026-09-28。状态:已接受。FOL-85。改 [ADR 0022](0022-global-token-ref-index.md) 的「谁来刷、在哪刷」(原为 Worker 的 23:00 cron);表结构、差量写(FOL-68)、护栏一概不动。接着 [ADR 0055](0055-queue-fan-out-one-account-per-invocation.md) 末尾「没做的」那一条。

## 背景

免费计划一次调用 10ms CPU。每天 23:00 那个 cron 里刷 `global_token_ref_index`:拉 `coins/list?include_platform=true`(约 2.6 MB)+ `asset_platforms` → 转成约 2.3 万行 → keyset 扫库做差量。生产 Workers Logs 480–520ms CPU,**7 次里 2 次 exceededCpu**;本机 harness(`perf:cpu:jobs`)稳态约 390ms(`apps/web/scripts/perf/baselines/jobs-before-2026-09-28.txt`)。大头是 JSON 解析 + 转换 + 逐行比对,**跟行数成正比,没有能抠到 10ms 的常数**;写入稳态本来就是 0(FOL-68)。

这一趟与用户无关、一天一次、晚一小时无所谓 —— 正是不必在 Worker 里跑的那种活。

## 决定

**挪到 GitHub Actions 的定时 workflow**(`.github/workflows/ref-index-refresh.yml`,每天 23:00 UTC + 手动触发),跑一个 Node 脚本(`apps/web/scripts/ref-index/refresh.ts`,经 `tsx` 直接跑 TS)。

- **逻辑零复制。** 脚本是参考层的**第二个装配点**:同一个 `GlobalRefIndexService`(拉两个端点 → adapter 的 `toRefIndexRows` → `GlobalDatabase.refIndex.putAll` 差量写),同一个 `coinGeckoUpstreamLayers`,同一个 `coinGeckoConfigOf`(`COINGECKO_API_KEY` / `COINGECKO_API_BASE` 的读法,从 `oracle.ts` 抽成纯件 `lib/server/coingecko-config.ts`),失败经同一个 `toError` 成句。
- **连接换成一条 SQL 传输。** `@folio/db` 新出 `provideRemoteDbClient(remote: RemoteSql)`:drizzle 的 `sqlite-proxy` 驱动接在调用方给的传输上,得到的是**同一个** `DbClient`(同一段桥、同一个 span、同样的 defect 语义)。与 `provideDbClient(env)` 同一条红线:给的是传输,拿不回 drizzle 句柄(原则 #6)。脚本给两种传输:
  - **D1 REST API**(`scripts/ref-index/d1-http.ts`):`POST /accounts/{account_id}/d1/database/{database_id}/raw`,单条 `{ sql, params }`、一批 `{ batch: [...] }`(一批一次请求);`/raw` 回值数组,正好是代理驱动要的形状。`account_id` / `database_id` 用 wrangler 自己的 `unstable_readConfig` 从 `wrangler.jsonc` 读(懂 JSONC 与 `--env`),不另抄。本地先拦两条限:每条语句 ≤ 100 个绑定参数、每次请求体 ≤ 1 MB;429 / 5xx / 网络断退避重发(写是 upsert / 按主键删,幂等)。token 只进 `Authorization` 头,错误信息里只有状态码与 Cloudflare 的 `errors[]`。
  - **本机 SQLite 文件**(`scripts/ref-index/sqlite-file.ts`,`node:sqlite`):`--local <文件 | persist 目录>`。本地开发灌 `pnpm dev` 的库(`ref-index:local`,顶替原来 curl 23:00 cron 的 `sync:ref:local`),perf harness 灌 perf 库。
- **`--dry-run`**:读照常(差量要对着真表算),写一条都不往下发,打印「本来要写几条几批」。
- **Worker 这边删掉**:`scheduled()` 的 23:00 分支只剩 `enqueueDailyJobs`(不再自己兜住 —— 以前兜是为了不挡后面的刷表,现在它就是整次调用,失败就该上抛记 error);`withOracleWarm`、isolate 服务图里的 `GlobalRefIndexService`、`oracleServices` 对它的合并都删了。常量 `GLOBAL_REF_INDEX_CRON` 改名 `DAILY_CRON`。
- **workflow**:`permissions: contents: read`、`concurrency: ref-index-refresh`(不取消进行中的)、`timeout-minutes: 15`;复用部署那把 `CLOUDFLARE_API_TOKEN`(本来就有 D1:Edit),可选 `COINGECKO_API_KEY`。链对照失配在 Actions 里打成 `::warning::`(以前是 Workers Logs 里的一行 warn)。

## 为什么不是别的

- **拆成队列消息分片跑**:转换本身要整份目录(先有平台表才知道每个地址属于哪条链),分片就得把 2.6 MB 先落到某处再分着读 —— 多一张中转表、多一套分片协议,换来的只是把同一份 CPU 摊进几十次调用。
- **付费计划 / Durable Object**:为一个一天一次、可以晚一天的缓存刷新付钱不值当。
- **`wrangler d1 execute --remote --file` + 生成的 SQL**:要先把差量算出来(那就得先读远端表 —— 又是一条传输),SQL 文件还得自己切批、自己守参数上限;REST 那条路的批就是 `putAll` 自己切的。
- **在脚本里重写一份转换 + 差量**:两份实现迟早漂;现在 Worker 的 D1 测试(workerd 里的 `putAll`)与 Node 测试(同一个 `putAll` 跑在 SQLite 文件与假的 REST 上)钉的是同一段代码。

## 代价(收下的)

- **GitHub 的 schedule 不准点**:常晚 10–60 分钟,偶尔丢一次;公开仓库 60 天无提交会被自动停掉。这张表本来就「新币最多滞后一天」,晚一点、丢一天都只是那几个新币多等一轮。**23:30 那次 sweep 不再保证用上当天的新映射**(以前靠半小时错位保证),最坏晚一天。
- **失败的可见性换了地方**:从 Workers Logs 的 error 变成一次红掉的 Actions run(GitHub 默认邮件通知 owner)。
- **REST 批量体(`{ batch: [...] }`)未在真 D1 上验过**:本仓不碰真 Cloudflare。请求形状照 Cloudflare API 的 D1 query/raw 端点;单测用假 fetch 钉形状、批、错误与重试,SQLite 文件那条路端到端跑过。首次部署后手动跑一次 workflow(先 dry run)即是验收。
- **wrangler 的 `unstable_readConfig`**:名字里带 unstable;wrangler 版本在 catalog 里钉着,升级时这里跟着验一次。
- **多一个 dev 依赖 `tsx`**(Node 直接跑本仓的 TS 源码:内部包无构建步骤、导入不带扩展名,Node 自带的去类型做不到后者)。

## 首次部署 / 升级

部署完手动跑一次 **Actions → Ref index refresh → Run workflow**(见 `apps/web/DEPLOY.md` 的「Global token map refresh」一节)。Worker 的 23:00 cron 不再填这张表。
