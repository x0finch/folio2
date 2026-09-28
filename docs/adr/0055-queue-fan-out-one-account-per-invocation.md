# 0055 — 后台活走 Cloudflare Queue:一条消息一个账户,一条消息一次调用

日期:2026-09-28。状态:已接受。FOL-86。**不改** [ADR 0048](0048-sync-round-state-lives-server-side.md) 的轮状态模型(服务端事实、条件单语句写),只改「谁来跑、在哪次调用里跑」。

## 背景

免费计划**每一次调用** —— HTTP、cron、queue consumer 一视同仁 —— 只有 10ms CPU、50 个外部 subrequest。整点 cron(`30 * * * *`)在**一次** `scheduled()` 里把「每个用户 × 每个账户」同步完,再逐用户预热代币缓存。生产 Workers Logs 的 `cpuTimeMs`:中位 700ms,**42% 的整点 sweep 以 `exceededCpu` 被杀**。只有一个用户;单账户的同步本身就重,所以「一次调用跑完所有账户」这个形状在免费计划上注定超预算,不是某处能抠出来的常数。

## 决定

**cron 只投活,活在队列 consumer 里一条消息一次调用地跑。**

- **一个队列 `JOBS`**(`folio-jobs`,死信 `folio-jobs-dlq`;preview 一对自己的,test 只在本地),`max_batch_size: 1`、`max_retries: 3`、`retry_delay: 30`、`max_concurrency: 6`。
- **消息是判别联合**(`apps/web/src/lib/server/jobs/message.ts`,Effect Schema):今天两种 —— `sync-account { userId, portfolioId, roundId, accountId }`、`warm-user { userId }`。消息只装找得到活的 id,不装数据。后续(FOL-88)按件加 `prices` / `fx` / `platforms` / `catalogue` / `defi-logos` / `prune-notes` / `daily-prices`:加一个 struct 进 union,`consume.ts` 的两个 `switch` 各接一支(穷尽检查,忘了接编译不过)。
- **cron(`fanOutAllUsers`)**:逐用户开轮(与以前同一段分区逻辑)→ 每个账户一条 `sync-account` → 每个用户一条延后 120s 的 `warm-user` → `sendBatch`。**不出网**(测试钉着)。空组合的轮当场收官。
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

## 没做的(各有票)

- `/api/sync` 与 `syncAccount` 仍在 HTTP 调用里 `waitUntil` 跑整轮(FOL-89 转成投队列)。
- `warm-user` 仍是整段 `warmTokens`(FOL-88 按件拆)。
- 每天那个 cron(剪 note + 刷全局映射表)不动。
