# 0058 — 后台活在一个 Durable Object 的 alarm 里跑,不再走 Cloudflare Queue

日期:2026-09-29。状态:已接受,**前提待上线实测**(见「前提」)。FOL-100。取代 [ADR 0055](0055-queue-fan-out-one-account-per-invocation.md) 的**运输层**;消息形状、「一件活一次调用」、consumer 的 ack / retry 判定、「最后一个落账的收官」都不变。

## 背景

FOL-86 把后台活从「cron 一次调用跑完所有账户」拆成「一条队列消息一次调用」。拆完之后本地实测(`perf:cpu:jobs`,见 `apps/web/scripts/perf/baselines/before-after-2026-09-28.md`)每件活的 CPU:`sync-account` 约 48ms、`prices` 约 28ms、`catalogue` 约 29ms、`prune-notes` 约 20ms、`fx` 约 14ms —— **免费计划队列 consumer 每次调用只有 10ms CPU**,几乎每件都还超。其中 `sync-account` 的大头是 Effect 运行时本身(约 40%),不是某段能抠掉的业务代码;再往下抠(FOL-98 / FOL-99:把同步内核移出 Effect、甚至整仓去掉 Effect)代价很大、收益也未必够到 10ms。

## 决定

**一个 SQLite 存储的 Durable Object(`JobRunner`)当调度 + 干活的那个;cron / server fn 只是闹钟;D1 仍是结果账本。**

- **投活**:`jobs/queue.ts` 的 `enqueue` 仍是那一个端口(测试照旧 provide 假实现),默认实现从 `env.JOBS.sendBatch` 换成对运行器的一次 RPC(`JOB_RUNNER.get(idFromName("jobs")).enqueue(batch)`)。延迟(`delaySeconds`)照旧。
- **排队**:活存在 DO 自己的 SQLite 里(`jobs/store.ts`):一行一件,`run_at` / `attempts` / `dead_at` / `last_error`。
- **跑**:`alarm()` 一次领**一件**到点的活(`jobs/runner.ts` 的 `runOneDueJob`),包成 consumer 认的那个 `QueueMessage` 形状交给**原来那个** `consumeMessage`,按它的 ack / retry 记下场,再按下一件的到点时间定 alarm。一次只跑一件,是因为每次调用 50 个外部 subrequest 的上限照旧,活已按它切好(FOL-86)。
- **重试自己排,不交给平台**:alarm 永远正常返回;失败的活按指数退避 30s → 60s → 120s 再跑(`jobRetryDelayMs`),平台对 alarm 自己的重试只有 6 次、间隔不由我们定。次数用完(consumer 已先收尾:账户记 failed)→ **埋掉**(`dead_at`),保留 7 天给人看 —— 等价于以前的死信队列。
- **次数在跑之前就加**:领活时 `attempts + 1`、`run_at` 推到租期之后(`JOB_LEASE_MS` = 一次投递最坏耗时 + 余量)。DO 跑到一半被驱逐,活不丢,过了租期再跑,而且那一次算数。**领到时次数已经超了**(上一次本该是最后一次,却没跑完)→ 不再跑,先走 consumer 的收尾(`abandonMessage`:`sync-account` 把账户记 failed)再埋掉 —— 一件每次都把 DO 跑崩的活不会每个租期重来一遍。
- **不只靠 `getAlarm()`**:alarm 跑的那段时间里它是 `null`。每次定 alarm 都按**表里的事实**(最早的 `run_at`)来,并把定下的时刻**自己记一份**(`meta.alarm_at`,只在真定了的时候写)。cron 两个 trigger 每次都额外 `poke()` 一下:有到点的活、而自己记的 alarm 时刻过了 15 分钟还没被刷新 → 记 warn,**不管 `getAlarm()` 怎么说**都强制重定。alarm 链万一断了,最迟一小时被捡起来。alarm 整段兜住、永远正常返回 —— 处理函数里的错不会触发平台的重试;DO 被驱逐 / 超 CPU 时平台照样会重试那次 alarm,那一种由租期与计次兜住(见上一条)。
- **轮的心跳**按新的最长退避倒推:80 + 120 + 10 = 210s;前端等单账户同步的上限:4 × 80 + (30 + 60 + 120) + 3 × 10 = 560s,再加余量。

## 没照搬的两条

- **「游标和结果同一个 batch 写进 D1」**:活的下场记在 DO 自己的 SQLite,结果写 D1,两边不在一个事务里。要做到同批,就得把活表搬进 D1(每次领活 / 记下场都是 D1 的往返与行写,吃 D1 每天 10 万行写入),换来的只是「少一次重复执行」—— 而每件活本来就幂等。所以保留 at-least-once,见「代价」。
- **「全量重跑用只有新代码才有的版本标记」**:那是给「分步处理一个大集合、游标走到底」的形状用的。这里没有游标:每件活是一个独立的小单位,cron 每小时重新投一遍,新代码上线后下一轮自然按新代码跑,不需要标记。

## 前提(没验证)

**免费计划上,DO 的每次调用(含 alarm)到底有多少 CPU?** Cloudflare 的 DO limits 页说法前后不一:表格写「CPU per request 30 seconds (default)」,不分套餐,FAQ 也说每次 DO 调用(HTTP / WebSocket / Alarm)默认 30s;同一页开头又说「Workers Limits apply according to your Workers plan」,FAQ 还有一句「same per invocation CPU limits as any Workers do」(免费计划 = 10ms)。Workers limits 页则把「把重计算挪到 Durable Objects」列为超 CPU 的解法之一。

**所以第一次上线就是实测**:看 Workers Logs 里 `JobRunner` 的 alarm 调用 —— `outcome` 是 `ok` 还是 `exceededCpu`、`cpuTimeMs` 多少(`perf:cpu:online`)。是 `exceededCpu` → 前提不成立,回退这个改动,回到 FOL-98 那条路。

## 为什么不继续用队列

- 队列 consumer 的 10ms 是硬顶;DO 如果真有 30s,本地实测最重的一件(约 50ms)也只用掉零头。
- 队列要先 `wrangler queues create`(每个环境两条);DO 随部署按 `migrations` 建出来,少一步手工。
- 代价见下。

## 代价

- **单线程**:一个实例,所有用户的活排在一条线上(以前是 `max_concurrency: 6`)。自托管、用户少,一小时十来件活是秒级;真排不过来的那天,按用户分片是换个 `idFromName` 的事。
- **积压会让轮被判「中断」**:轮的心跳(210s)按「一件活最坏耗时 + 最长退避」倒推,**不含排队**。以前队列并发 6,排队是边角;现在是单线程,多个用户的整点 sweep 叠在一起、排在前面的活够慢时,后面那一轮会先被面板念成「中断」—— 晚到的落账带着同一个轮 id 照样落得上、照样收官,只是那段时间里再点一次同步能覆盖它。用户一多就该先分片,而不是把心跳放宽。
- **运行器自己的状态与 D1 不在一个事务里**:活的下场记在 DO 的 SQLite,结果写在 D1。所以仍是 at-least-once —— 与队列时代相同,每件活本来就按幂等写(同小时一张快照、价格按键 upsert、轮的落账带轮 id 条件)。
- **免费额度**:DO 一天 10 万次请求(每次 alarm 一次、每次投活 RPC 一次)、13,000 GB-s 时长;DO 存储按行写计费(每天 10 万行):一件活粗算 8–10 行 —— 插入、领、删各写一行、各连带一行 `jobs_due` 索引,外加定 alarm 时记一次时刻、`setAlarm` 本身也按一行算,失败重跑另加。一小时十来件活一天两三千行,远在其下。空跑的 alarm 不写。
- **可观测性换了地方**:以前在 Dashboard 的 Queues 页看死信,现在埋掉的活在 DO 存储里,日志里有 `job failed on final attempt, burying it`(最后一次跑失败)或 `job never finished its final attempt, burying it`(最后一次没跑完)。
- **切换那一刻,旧队列里还没消费的消息会丢**(consumer 已经删了)。只在 FOL-86 那一版真的部署过时才有;丢的是最多一小时的活,下一次整点 cron 重新投。

## 相关

- ADR 0055(被取代的运输层;消息与 consumer 仍以它为准)、ADR 0048(轮状态模型,不变)。
- FOL-98 / FOL-99(把同步移出 Effect / 去掉 Effect):前提成立时它们不再是 CPU 驱动的必需品。
