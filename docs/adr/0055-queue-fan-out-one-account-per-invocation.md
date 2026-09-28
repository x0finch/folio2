# 0055 — 后台活走 Cloudflare Queue:一条消息一个账户,一条消息一次调用

日期:2026-09-28。状态:已接受。FOL-86。**不改** [ADR 0048](0048-sync-round-state-lives-server-side.md) 的轮状态模型(服务端事实、条件单语句写),只改「谁来跑、在哪次调用里跑」。

## 背景

免费计划**每一次调用** —— HTTP、cron、queue consumer 一视同仁 —— 只有 10ms CPU、50 个外部 subrequest。整点 cron(`30 * * * *`)在**一次** `scheduled()` 里把「每个用户 × 每个账户」同步完,再逐用户预热代币缓存。生产 Workers Logs 的 `cpuTimeMs`:中位 700ms,**42% 的整点 sweep 以 `exceededCpu` 被杀**。只有一个用户;单账户的同步本身就重,所以「一次调用跑完所有账户」这个形状在免费计划上注定超预算,不是某处能抠出来的常数。

## 决定

**cron 只投活,活在队列 consumer 里一条消息一次调用地跑。**

- **一个队列 `JOBS`**(`folio-jobs`,死信 `folio-jobs-dlq`;preview 一对自己的,test 只在本地),`max_batch_size: 1`、`max_retries: 3`、`retry_delay: 30`、`max_concurrency: 6`。
- **消息是判别联合**(`apps/web/src/lib/server/jobs/message.ts`,Effect Schema):今天七种 —— `sync-account { userId, portfolioId, roundId, accountId }`、`prices { userId, tokenIds? }`(FOL-87)、`fx` / `platforms` / `catalogue` / `defi-logos` / `prune-notes`(都是 `{ userId }`,FOL-88;原来的 `warm-user` 已拆掉),见文末两段补记。消息只装找得到活的 id,不装数据。后续(FOL-90 的 `daily-prices`):加一个 struct 进 union,`consume.ts` 的两个 `switch` 各接一支(穷尽检查,忘了接编译不过)。
- **cron(`fanOutAllUsers`)**:逐用户开轮(与以前同一段分区逻辑)→ 每个账户一条 `sync-account` → 每个用户补 `prices` / `fx`(不延后)+ `platforms` / `defi-logos`(延后 120s,FOL-88)→ `sendBatch`。**不出网**(测试钉着)。空组合的轮当场收官。
- **consumer(`server.ts` 的 `queue()` → `consumeMessage`)**:每条一次 `runAtEdge`,跑在同一个 isolate 运行时上(ADR 0054,不另起服务图)。`sync-account` 用**同一个同步内核**(`Sweep.syncUserStream` + `makeSyncServicesLayer`,`only` 收成那一个账户)→ `settle` → `finishIfSettled`。
- **「最后一个落账的收官」**:`@folio/db` 新增 `syncRounds.finishIfSettled` —— 一条条件 UPDATE(未收官 ∧ `json_each` 里零个 `pending`),并发的 consumer 只有一个抢得到,最后落账的那个必看得到零个 pending。
- **ack / retry 只在一处决定**:解不开 → ack + warn(重投也解不开);成功 → ack;失败且还有机会 → `retry()`;**最后一次仍失败 → 把账户记成 failed、够了就收官、ack**,只有连这一步都失败才进死信。`JOB_MAX_RETRIES` 与 wrangler 的 `max_retries` 由 `tests/queue-config.test.ts` 锁成一致。
- **上游失败不走队列重试**:同步内核自己已经重试、并把失败收成「这个账户 failed」。队列重试只接 defect(D1 瞬时错这类)。

## 为什么是队列,不是别的

- **更频繁的 cron、按用户分几个 cron**:每次调用仍是「若干账户」,预算随账户数线性超;cron 表达式也不能按数据动态加。
- **Durable Object / Workflows**:要么付费档,要么一整块新面积(状态、alarm、迁移)。队列在免费计划可用,语义(at-least-once、重试、死信)正好覆盖这里要的。
- **一次调用一条**:批大于 1,预算又被几个账户分着花。`max_batch_size: 1` 是这件事的全部要点。

## 代价(收下的)

- **队列跑的轮没有 keepalive**:没有一条任务从头跑到尾,续期全靠每次落账。积压超过 120s(`ROUND_HEARTBEAT_MS`)时面板会先说「中断」;晚到的落账带着同一个轮 id,照样落得上、续期、收官 —— 只是那段时间里一次手动同步可以覆盖它。单用户、个位数账户,正常延迟是秒级。
- **每用户并发闸没了**:以前 cron 一次调用里多轮共用一把进程内信号量(`SyncScope.gate`),拆成多次调用后递不过去,已删;上限改由 `max_concurrency: 6`(= `SYNC_CONCURRENCY`)给,且是**全队列**的上限,不是每用户。
- **cron 那一行日志不再有 ok / failed 小计**:同步还没跑。小计挪到收官那一刻(`queued round done`,每组合一行)。
- **队列操作计数**:每条消息约 3 次操作(写 / 读 / 删),免费计划一天 10k。每小时 (账户数 + 1) 条 × 24。
- **部署多一步**:`wrangler queues create` 一次(DEPLOY.md 3b);不建,`wrangler deploy` 直接失败。

## 补记:持仓价拆成 `prices` 活,同步只读价表(FOL-87)

上面那条 `sync-account` 消息的预算里藏着一个随持仓数线性长的东西:同步的重估对每笔要源价的持仓调一次 `tokens.priceOf`(SWR:stale 就当场回源),并发无上限、不成批。价 TTL 30 分钟、同步每小时一次,所以几乎每次同步都是「每个币一发 CoinGecko」。另有首页 / 账户页挂载时自动调的 `refreshStalePrices` server fn —— 一个读页面顺手打上游、写库。

- **新 kind `prices { userId, tokenIds? }`**(`apps/web/src/lib/server/prices/job.ts`)。cron 每用户投一条不带 id 的(**不延后**,与 `sync-account` 同批)。consumer 跑的那一刻读最新快照 + 手记合成余额算持仓 id(`heldTokenIdsOf`,与展示同一道 dust 门),切成每块 ≤ `PRICES_IDS_PER_MESSAGE`(1000)个:自己刷第一块,其余每块投一条带 `tokenIds` 的。刷用既有的 `tokens.refreshStale`(价 + 元信息两条端点,adapter 按 100 个一批)。1000 = 每端点 ≤ 10 发 × 2 端点 × 2 次尝试 = 最坏 40 发 ≤ 50。块上限写进 schema(`maxItems`),超了解码就拒。**先刷后投**:刷幂等、投不是。
- **重估只读表**:参考层 `tokens.priceOf`(SWR、会回源)换成 `tokens.pricesOf(ids)` —— 一次批读价表、零网络、不判新鲜度。`revalue` 先收齐要源价的 id,读一次,再逐笔 `valuate`;表里没有 → 自带价 / provider 原值。
- **`warm-user` 不再刷价**(`warmReferenceFor`:平台 / DeFi 图 / 汇率 / 目录)。手动同步的收尾(`warmTokens`)仍在自己那次 HTTP 调用里连价一起刷、不切块 —— FOL-89 把它们转成投队列时改投一条 `prices`。
- **`refreshStalePrices` server fn、`useStalePriceRefresh` hook、`prices.refreshed` 失效事件删了。** 前端的 `pricesStale` 仍算,只是没人再因为它发请求。

**代价(收下的)**:`prices` 与 `sync-account` 并发、谁先跑不定,所以这一轮快照里冻的 value 可能用上一轮刷的价(最多约一小时旧;展示层按价表现价重算,不受影响)。这一轮新出现的币要到下一轮 `prices` 才有价,在那之前按自带价 / provider 原值估。不让同步等价(延后投同步)是因为延后的是用户看得见的同步进度。页面上的价最旧约 1.5 小时(cron 间隔 + TTL),以前打开页面会顺手刷。

## 没做的(各有票)

- `/api/sync` 与 `syncAccount` 仍在 HTTP 调用里 `waitUntil` 跑整轮(FOL-89 转成投队列)。
- ~~`warm-user` 剩下的四件仍是一条~~ —— FOL-88 已拆,见文末补记。
- 每天那个 cron 刷全局映射表那半不动(FOL-85 挪到 GitHub Actions);剪 note 那半 FOL-88 已改成投消息。

## 补记:参考层拆成一件一条,读端点只读缓存(FOL-88)

`warm-user` 一条消息里叠着四件(汇率 / 平台 / 目录 / DeFi 图),每天那个 cron 还在一次调用里逐用户串行剪 note。拆开:

- **五个 kind,都只带 `userId`**(汇率 / 平台 / 目录 / DeFi 图都住 per-user 的 `user_cache`,note 在用户的快照上,没有一件是全局的)。consumer 在 `sync/reference.ts`(前四件)与 `entry/note-retention.ts`(剪 note)。每件最坏出网数在 `jobs/constants.ts` 的 `REFERENCE_JOB_UPSTREAM_CALLS` 里逐件推导:`fx` 2、`platforms` 2、`catalogue` 8(1000 个 / 每页 250 × 2 次尝试)、`defi-logos` 0、`prune-notes` 0 —— 都远低于 50,不必切块。测试按真 fetch 数钉着,并钉「重跑零出网」。
- **幂等**:前三件各按参考层自己的 TTL 门控(汇率 6h、平台一天、目录一周;新鲜就一次批量缓存读、零出网),DeFi 图是同值覆盖写,剪 note 是带 `IS NOT NULL` 门的 UPDATE。
- **谁投、多久投一次只在 `jobs/schedule.ts`**。每小时:`prices`、`fx`、`platforms` / `defi-logos`(读最新快照 → 延后到同步落库之后)。每天(23:00 那个 trigger,刷全局映射表之前、自己兜住 —— 刷表持续失败也挡不住剪 note):`prune-notes`、`catalogue`(一周 TTL,每小时投是 167 条空跑换一次真刷)。
- **新鲜度判在 consumer,不在 cron**:cron 里先读缓存再决定投不投,那次读要逐用户落在 cron 那一次调用的 10ms 里;consumer 本来就要读这一次。多投一条的代价约 3 次队列操作。每用户每小时 (账户数 + 4) 条、每天另 2 条。
- **读端点不出网**:`getCurrencyPreference`(`displayRate`)与 `listFiatOptions` 不再冷缓存就 `fx.warm`,只读缓存;没有汇率 → 前者整体回退 USD(原有形状),后者那一项不带价(原有形状)。切换器在「选了 EUR 却回退 USD」时提示一句(汇率一小时内会暖上)。同步重估里的 `fx.resolve` **本来就只读缓存**(软过期、不回源)—— FOL-87 补记里说它是 SWR 是写错了;现在有测试钉着它零出网。

**代价(收下的)**:新用户在第一个整点 cron 之前切展示币种只能看美元(以前冷缓存会当场拉)。`refreshTokenPrices`(选币下拉的批量刷价,本来就是一个为回源存在的用户触发端点)仍会顺手 `fx.warm` 法币 —— 没动。升级那一刻队列里还没消费的 `warm-user` 解不开,按既有规则 ack + warn 丢掉,下一小时的 cron 补上。手动同步的收尾(`warmTokens`)仍在自己那次 HTTP 调用里连做价 + 这四件(FOL-89 转成投消息)。
