# 0055 — 后台活走 Cloudflare Queue:一条消息一个账户,一条消息一次调用

日期:2026-09-28。状态:**运输层已被 [ADR 0058](0058-background-jobs-run-in-a-durable-object.md) 取代**(队列 → Durable Object 的 alarm);消息形状、一件活一次调用、ack / retry 的判定、「最后一个落账的收官」都照旧。FOL-86。**不改** [ADR 0048](0048-sync-round-state-lives-server-side.md) 的轮状态模型(服务端事实、条件单语句写),只改「谁来跑、在哪次调用里跑」。

## 背景

免费计划**每一次调用** —— HTTP、cron、queue consumer 一视同仁 —— 只有 10ms CPU、50 个外部 subrequest。整点 cron(`30 * * * *`)在**一次** `scheduled()` 里把「每个用户 × 每个账户」同步完,再逐用户预热代币缓存。生产 Workers Logs 的 `cpuTimeMs`:中位 700ms,**42% 的整点 sweep 以 `exceededCpu` 被杀**。只有一个用户;单账户的同步本身就重,所以「一次调用跑完所有账户」这个形状在免费计划上注定超预算,不是某处能抠出来的常数。

## 决定

**cron 只投活,活在队列 consumer 里一条消息一次调用地跑。**

- **一个队列 `JOBS`**(`folio-jobs`,死信 `folio-jobs-dlq`;preview 一对自己的,test 只在本地),`max_batch_size: 1`、`max_retries: 3`、`retry_delay: 30`、`max_concurrency: 6`。
- **消息是判别联合**(`apps/web/src/lib/server/jobs/message.ts`,Effect Schema):今天八种 —— `sync-account { userId, portfolioId, roundId, accountId }`、`prices { userId, tokenIds? }`(FOL-87)、`daily-prices { userId, tokenIds? }`(FOL-90)、`fx` / `platforms` / `catalogue` / `defi-logos` / `prune-notes`(都是 `{ userId }`,FOL-88;原来的 `warm-user` 已拆掉),见文末两段补记。消息只装找得到活的 id,不装数据。加新 kind 的路(FOL-90 的 `daily-prices` 就是这么加的):加一个 struct 进 union,`consume.ts` 的两个 `switch` 各接一支(穷尽检查,忘了接编译不过)。
- **cron(`fanOutAllUsers`)**:逐用户开轮(与以前同一段分区逻辑)→ 每个账户一条 `sync-account` → 每个用户补 `prices` / `fx`(不延后)+ `platforms` / `defi-logos`(延后 120s,FOL-88)→ `sendBatch`。**不出网**(测试钉着)。空组合的轮当场收官。
- **consumer(`server.ts` 的 `queue()` → `consumeMessage`)**:每条一次 `runAtEdge`,跑在同一个 isolate 运行时上(ADR 0054,不另起服务图)。`sync-account` 用**同一个同步内核**(`Sweep.syncUserStream` + `makeSyncServicesLayer`,`only` 收成那一个账户)→ `settle` → `finishIfSettled`。
- **「最后一个落账的收官」**:`@folio/db` 新增 `syncRounds.finishIfSettled` —— 一条条件 UPDATE(未收官 ∧ `json_each` 里零个 `pending`),并发的 consumer 只有一个抢得到,最后落账的那个必看得到零个 pending。
- **ack / retry 只在一处决定**:解不开 → ack + warn(重投也解不开);成功 → ack;失败且还有机会 → `retry()`;**最后一次仍失败 → 先收尾(`sync-account`:把账户记成 failed、够了就收官),再 `retry()` 送进死信**(重投次数已用完,这一下就是进死信;FOL-86 验收「失败消息进死信可见」)。收尾失败也照样进死信。死信队列**没有 consumer**,不会被原样再跑一遍;有人手动把它重放回主队列,`sync-account` 也会被「还 pending 吗」挡下。`JOB_MAX_RETRIES` / `JOB_RETRY_DELAY_SECONDS` 与 wrangler 的 `max_retries` / `retry_delay` 由 `tests/queue-config.test.ts` 锁成一致(它也钉着「死信没有 consumer」)。(这一条原先写的是「收尾后 ack、只有收尾失败才进死信」,#571 review 改,见文末补记。)
- **上游失败不走队列重试**:同步内核自己已经重试、并把失败收成「这个账户 failed」。队列重试只接 defect(D1 瞬时错这类)。

## 为什么是队列,不是别的

- **更频繁的 cron、按用户分几个 cron**:每次调用仍是「若干账户」,预算随账户数线性超;cron 表达式也不能按数据动态加。
- **Durable Object / Workflows**:要么付费档,要么一整块新面积(状态、alarm、迁移)。队列在免费计划可用,语义(at-least-once、重试、死信)正好覆盖这里要的。
- **一次调用一条**:批大于 1,预算又被几个账户分着花。`max_batch_size: 1` 是这件事的全部要点。

## 代价(收下的)

- **队列跑的轮没有定时 keepalive**:没有一条任务从头跑到尾,续期挂在每次落账与每次投递开跑前(`touch`)。`ROUND_HEARTBEAT_MS` 由重投链倒推:一次投递最坏 80s + `retry_delay` 30s + 调度余量 10s = 120s,所以重投还没用完时轮不会被念成「中断」(#571 review 补上开跑前那次续期)。积压到一条消息排队超过 120s 才被派出去时面板仍会先说「中断」;晚到的落账带着同一个轮 id,照样落得上、续期、收官 —— 只是那段时间里一次手动同步可以覆盖它。单用户、个位数账户,正常延迟是秒级。
- **每用户并发闸没了**:以前 cron 一次调用里多轮共用一把进程内信号量(`SyncScope.gate`),拆成多次调用后递不过去,已删;上限改由 `max_concurrency: 6`(= `SYNC_CONCURRENCY`)给,且是**全队列**的上限,不是每用户。
- **cron 那一行日志不再有 ok / failed 小计**:同步还没跑。小计挪到收官那一刻(`queued round done`,每组合一行)。
- **队列操作计数**:每条消息约 3 次操作(写 / 读 / 删,`QUEUE_OPS_PER_MESSAGE`),免费计划一天 10k。**今天的数**(FOL-90 之后):cron 每用户每小时 (账户数 + 5) 条(`sync-account` × N + `prices` / `daily-prices` / `fx` / `platforms` / `defi-logos`),每天另 2 条(`prune-notes` / `catalogue`);每次手动全量同步另 (N + 5) 条、每次单账户同步另 (1 + 5) 条,手记写完的定向 `daily-prices` 各 1 条;失败重投每次再 +1 条。单用户 5 个账户:cron 一天 (5 + 5) × 24 + 2 = 242 条 ≈ 730 次操作,离 10k 很远 —— 真正吃配额的是手动同步的频率。cron 那一行日志(`cron sweep enqueued`)带 `queueOps` 字段 = 这一趟投的条数 × 3,手动 / 单账户那几条不在里面。(原先这里写「(账户数 + 1) 条 × 24」,FOL-88 / FOL-90 两次加 kind 没跟着改,#571 review 更正。)
- **部署多一步**:`wrangler queues create` 一次(DEPLOY.md 3b);不建,`wrangler deploy` 直接失败。

## 补记:持仓价拆成 `prices` 活,同步只读价表(FOL-87)

上面那条 `sync-account` 消息的预算里藏着一个随持仓数线性长的东西:同步的重估对每笔要源价的持仓调一次 `tokens.priceOf`(SWR:stale 就当场回源),并发无上限、不成批。价 TTL 30 分钟、同步每小时一次,所以几乎每次同步都是「每个币一发 CoinGecko」。另有首页 / 账户页挂载时自动调的 `refreshStalePrices` server fn —— 一个读页面顺手打上游、写库。

- **新 kind `prices { userId, tokenIds? }`**(`apps/web/src/lib/server/prices/job.ts`)。cron 每用户投一条不带 id 的(**不延后**,与 `sync-account` 同批)。consumer 跑的那一刻读最新快照 + 手记合成余额算持仓 id(`heldTokenIdsOf`,与展示同一道 dust 门),切成每块 ≤ `PRICES_IDS_PER_MESSAGE`(1000)个:自己刷第一块,其余每块投一条带 `tokenIds` 的。刷用既有的 `tokens.refreshStale`(价 + 元信息两条端点,adapter 按 100 个一批)。1000 = 每端点 ≤ 10 发 × 2 端点 × 2 次尝试 = 最坏 40 发 ≤ 50。块上限写进 schema(`maxItems`),超了解码就拒。**先刷后投**:刷幂等、投不是。
- **重估只读表**:参考层 `tokens.priceOf`(SWR、会回源)换成 `tokens.pricesOf(ids)` —— 一次批读价表、零网络、不判新鲜度。`revalue` 先收齐要源价的 id,读一次,再逐笔 `valuate`;表里没有 → 自带价 / provider 原值。
- **`warm-user` 不再刷价**(`warmReferenceFor`:平台 / DeFi 图 / 汇率 / 目录)。手动同步的收尾(`warmTokens`)仍在自己那次 HTTP 调用里连价一起刷、不切块 —— FOL-89 把它们转成投队列时改投一条 `prices`。
- **`refreshStalePrices` server fn、`useStalePriceRefresh` hook、`prices.refreshed` 失效事件删了。** 前端的 `pricesStale` 仍算,只是没人再因为它发请求。

**代价(收下的)**:`prices` 与 `sync-account` 并发、谁先跑不定,所以这一轮快照里冻的 value 可能用上一轮刷的价(最多约一小时旧;展示层按价表现价重算,不受影响)。这一轮新出现的币要到下一轮 `prices` 才有价,在那之前按自带价 / provider 原值估。不让同步等价(延后投同步)是因为延后的是用户看得见的同步进度。页面上的价最旧约 1.5 小时(cron 间隔 + TTL),以前打开页面会顺手刷。

## 没做的(各有票)

- ~~`/api/sync` 与 `syncAccount` 仍在 HTTP 调用里 `waitUntil` 跑整轮~~ —— FOL-89 已转成投队列,见文末补记。
- ~~`warm-user` 剩下的四件仍是一条~~ —— FOL-88 已拆,见文末补记。
- 每天那个 cron 刷全局映射表那半不动(FOL-85 挪到 GitHub Actions —— 已做,见 [ADR 0056](0056-ref-index-refresh-runs-in-github-actions.md));剪 note 那半 FOL-88 已改成投消息。

## 补记:参考层拆成一件一条,读端点只读缓存(FOL-88)

`warm-user` 一条消息里叠着四件(汇率 / 平台 / 目录 / DeFi 图),每天那个 cron 还在一次调用里逐用户串行剪 note。拆开:

- **五个 kind,都只带 `userId`**(汇率 / 平台 / 目录 / DeFi 图都住 per-user 的 `user_cache`,note 在用户的快照上,没有一件是全局的)。consumer 在 `sync/reference.ts`(前四件)与 `entry/note-retention.ts`(剪 note)。每件最坏出网数在 `jobs/constants.ts` 的 `REFERENCE_JOB_UPSTREAM_CALLS` 里逐件推导:`fx` 2、`platforms` 2、`catalogue` 8(1000 个 / 每页 250 × 2 次尝试)、`defi-logos` 0、`prune-notes` 0 —— 都远低于 50,不必切块。测试按真 fetch 数钉着,并钉「重跑零出网」。
- **幂等**:前三件各按参考层自己的 TTL 门控(汇率 6h、平台一天、目录一周;新鲜就一次批量缓存读、零出网),DeFi 图是同值覆盖写,剪 note 是带 `IS NOT NULL` 门的 UPDATE。
- **谁投、多久投一次只在 `jobs/schedule.ts`**。每小时:`prices`、`fx`、`platforms` / `defi-logos`(读最新快照 → 延后到同步落库之后)。每天(23:00 那个 trigger;FOL-85 之后它只做这一件,不再自己兜住,见 ADR 0056):`prune-notes`、`catalogue`(一周 TTL,每小时投是 167 条空跑换一次真刷)。
- **新鲜度判在 consumer,不在 cron**:cron 里先读缓存再决定投不投,那次读要逐用户落在 cron 那一次调用的 10ms 里;consumer 本来就要读这一次。多投一条的代价约 3 次队列操作。每用户每小时 (账户数 + 4) 条、每天另 2 条。
- **读端点不出网**:`getCurrencyPreference`(`displayRate`)与 `listFiatOptions` 不再冷缓存就 `fx.warm`,只读缓存;没有汇率 → 前者整体回退 USD(原有形状),后者那一项不带价(原有形状)。切换器在「选了 EUR 却回退 USD」时提示一句(汇率一小时内会暖上)。同步重估里的 `fx.resolve` **本来就只读缓存**(软过期、不回源)—— FOL-87 补记里说它是 SWR 是写错了;现在有测试钉着它零出网。

**代价(收下的)**:新用户在第一个整点 cron 之前切展示币种只能看美元(以前冷缓存会当场拉)。`refreshTokenPrices`(选币下拉的批量刷价,本来就是一个为回源存在的用户触发端点)仍会顺手 `fx.warm` 法币 —— 没动。升级那一刻队列里还没消费的 `warm-user` 解不开,按既有规则 ack + warn 丢掉,下一小时的 cron 补上。手动同步的收尾(`warmTokens`)仍在自己那次 HTTP 调用里连做价 + 这四件(FOL-89 转成投消息)。

## 补记:手动同步与单账户同步也只投活(FOL-89)

免费计划的 10ms 把 `waitUntil` 里的活一起算进那次请求。`POST /api/sync` 开完轮把整轮(`runSyncRound`)交给 `waitUntil`,`syncAccount` 在请求里同步一个账户再 `warmTokens`(价 + 参考层四件)—— 按钮上复刻了旧 cron 的超预算。

- **`POST /api/sync`(`round.ts` 的 `startSyncRound`)**:开轮(不变,开轮幂等)→ 自动轮先在请求里做 `planFreshSkips`(只有 D1,不出网)→ 每个没被跳过的账户一条 `sync-account` + `hourlyUserJobs`(与 cron 同一份、同一套延后)→ 回轮的此刻样子。**活轮还在就一条都不投**。没有消息要投(空组合、自动轮里全都新鲜)→ 当场 `finishIfSettled`,参考层那几条也不投(没写新快照,整点 cron 照投)。投递炸了 → 带一句话收官再失败,面板说「没跑起来」而不是干等 120s。`waitUntil` 从这条路上消失,`drive.ts`(keepalive + 流驱动)、`syncRoundFor`、`userLayer`、`warmTokens`、`warmReferenceOf` 一并删除。
- **`syncAccount`(`run.ts` + `round.ts` 的 `startAccountRound`)**:当场答得出的不排队 —— 手记 / 已归档 / **凭据没填完**(同 `needsCredentials` 的判据)直接回结果;其余把账户排进**它所属组合**的一轮:没有活轮就开一轮只装它一个的;有活轮就 **`syncRounds.enlist`**(新 db op:一条条件 UPDATE,只对未收官 ∧ 未过期的那一轮生效,名单外的加进来、已落账的记回 `pending`、续心跳),不覆盖别人的轮;enlist 落空(活轮恰在两句之间收官 / 过期)再开一次。投一条 `sync-account` + `hourlyUserJobs`,回 `{ queued, portfolioId, roundId, round }`。
- **前端等轮,不等请求**:`SyncRoundView` 多一个 `statuses`(accountId → 下场)。`lib/queries/account-sync.ts` 的 `syncAccountAndWait` 发起后把回包落进 `syncKeys.round` 缓存(页头胶囊立刻转),再按 `POLL_INTERVAL.syncRound` 读 `getSyncRound`,直到**这个账户**落账,念成以前内联结果的形状(`ok` / `skipped` / `skipReason` / `error`)。详情侧栏的 mutation 与加账户 / 补凭据后的后台同步都走它;加账户那条现在会把同步失败 toast 出来(以前静默)。
- **幂等**:同一个账户的两条消息(连点、手动撞 cron、enlist 已 pending 的)—— consumer 的「这一轮里它还 pending 吗」让后到的那条空跑(测试按出网数钉着);同钟点快照折叠(#461)兜住其余。

**代价(收下的)**:单账户同步开的轮是那个组合的「最近一轮」,面板的「本轮」会报「1 个已同步」直到下一次全量 / cron 覆盖它。手动轮也不再有 keepalive(与 cron 的轮同待遇,见上文「代价」)。**本地开发**:`@cloudflare/vite-plugin` 的 Miniflare 带本地队列(生产者 + consumer 同一个 worker,支持 `delaySeconds` 与重试),`pnpm dev` 照样能同步,但它**串行**消费(一批跑完才派下一批,不认 `max_concurrency`),所以本地一轮 N 个账户是顺序跑的,参考层那几条(打真 CoinGecko)也排在同一条队里。


## 补记:手记曲线的历史日价拆成 `daily-prices` 活,读图表只读表(FOL-90)

手记账户不写快照(ADR 0018),曲线由账本 × 每日价现算。那份每日价以前在**读**的时候补:`getPortfolioHistory` / `getAccountHistory` / 带 `after` 的 `getSnapshots` 经 `buildHistoricalPriceAt` 调 `tokens.priceSeries` / `fx.rateSeries`,而这两个是 SWR —— 「今天」永远算没缓存,所以**每看一次图表**每个认得出来的币一发 `coinsMarketChartRange`(法币两发),缺的过去日还要再补。

- **新 kind `daily-prices { userId, tokenIds? }`**(`apps/web/src/lib/server/prices/daily.ts`)。目标 = 用户所有手记账户(含归档)里会画出来的币(`manualDailyPriceTargets`:与曲线同一个 `loadHistoryTokens`、同一道 recognized 门),各从最早一笔活动那天起;法币补日汇率(`fx.fillDaily`,BTC 两腿反算,落 `fiat/issued:<CODE>`),其余补币价(`tokens.fillDaily`)。两者共用 `packages/oracle/entry/src/daily-fill.ts`。
- **只补过去日**,补到昨天为止。一发区间请求覆盖 ≤ `DAILY_FILL_DAYS_PER_CALL`(365)天(长于三个月上游按日给点,解析便宜)。**「试过哪一段」记在 per-user 缓存**(`daily-cover:<目标>` → `{ lo, hi }`,连续闭区间):只看表的话,上游**就是没有点**的日子(币还没上线、断档)每小时都算「缺」、每小时白打一发。先往后补(`hi` 之后到昨天,升序),再往前补(降序);表里已有整窗的(别的用户补过、FOL-90 之前读路径落过的)直接算试过、不出网。
- **预算**:一条消息 ≤ `DAILY_PRICES_CALLS_PER_MESSAGE`(8)发区间请求,法币一窗按 2 发记账;× 2 次尝试 = 最坏 16 发 ≤ 50。没取到 25 是因为 10ms CPU 先到(一发一年 = 365 个点解析 + 365 行写;日价写入顺手改成多行 INSERT,30 行一条语句)。8 是**没实测**的保守值,FOL-84 的本地 profile 可以校准。预算用完还有没补完的 → 投**一条**带剩余 id 的后续消息(后续消息本身是串行接力;但整点那条与写后定向投的那条**可能并发**推同一个目标 —— 「已试区间」写入前重读并取并集,见 `packages/oracle/entry/src/daily-fill.ts`,仍有一个没有 compare-and-set 的小窗口,最坏是某个窗口多打一发);一发都没花出去(全失败)就不投,等下一个整点。测试按真 fetch 数钉着:三年 × 3 币 + 欧元 → 多条消息、每条 ≤ 16 发,补完重跑零出网。
- **谁投**:每小时 cron(`hourlyUserJobs`,不延后)—— 过了零点那一小时补一窗「昨天」,其余时候几次缓存读、零出网。外加手记写完之后定向投一条带**这个账户的币 id** 的:加活动(`createManualActivities`)、改活动(`updateManualActivity`,改日期可能把首笔挪早)、建手记账户(`createAccount`)。消息里的 userId 经 `enqueueForUser` 由装配点填(见文末补记;原先这三个与 `syncAccount` 一样绕开 `runEffect`、手递 `context.userId`);投递失败只记一行,不让已落库的写失败。
- **读路径只读表**:`priceSeries` / `rateSeries` 零网络 —— 过去日读 `token_daily_prices`;**今天读现价**(代币价表 / 汇率缓存,每小时的 `prices` / `fx` 活在刷)。**不往日价表写今天**:明天它就成了一个「不可变的过去日」,而那其实是某个钟点的价。回源只剩 `fillDaily`。
- **缺的日子前向填充**(`buildHistoricalPriceAt`,不落库):沿用之前最近一个有价的日子(还没补上的昨天、今天还没现价、上游断档)。第一个有价的日子之前(新币、活还没跑)→ 纯层降级链落账本价②/③,与以前「上游没给」同一条路。

**代价(收下的)**:每用户每小时多一条消息(FOL-88 补记里的「账户数 + 4」成了「+ 5」)。新加的币在它那条定向消息跑完之前(通常秒级)曲线按账本价画。某一窗永久失败(上游不给那么老的数据,如 CoinGecko 免费档一年以前)→ 每小时为它再白打一发(往后那段先补,挡不住「昨天」进表)。cron 的那条与定向 / 后续那条可能并发补同一个币:最坏多打几发、区间写回谁后到听谁的(可能缩回去,下一次再补一遍已有的窗 —— 表里有整窗就不出网)。升级那一刻已有的日价没有「试过」区间,第一次跑按窗读表判定,整窗都在的不出网。

## 补记:`sync-account` 不再经 Layer 与 Stream(FOL-83 第二轮)

上文「`sync-account` 用同一个同步内核(`Sweep.syncUserStream` + `makeSyncServicesLayer`)」改成:**`Sweep.syncOne(userId, accountId)` + `makeSyncServices({ only })`**。内核仍是同一个 —— `syncOne` 做的是 `syncUserStream` 同样的两次读(账户、凭据)、调同一个 `Account.syncAccount`,只是一个账户不走有界并发的流;`makeSyncServices` 是同一份接线造成一份 `Context`,`makeSyncServicesLayer` 就是它外面一层 `Layer.effectContext`(测试照旧用 layer)。省掉的是每条消息一遍的五层 `Layer.mergeAll` 与 Stream 的机器。同一轮还做了:刷价那一批改成一条 `UPDATE … FROM json_each(?)`(`prices` 本机 66 → 39ms)、目录那条活先看 `asOf` 再决定要不要解码整份目录、交易所 note 的数字格式不再拉起 ICU(一个 isolate 里第一次用 Intl 数字格式 ≈15ms)。数字与仍超 10ms 的原因见 `apps/web/scripts/perf/baselines/before-after-2026-09-28.md` 的「第二轮」。

## 补记:#571 review 收掉的几处

- **cron 与手动 / 自动轮(`POST /api/sync`)撞上单账户的轮都不再整组合跳过**(`claimPortfolio`,两条路共用,只差 `trigger`;review R2-#2 把手动 / 自动那条也接上):FOL-89 之后活轮可能只装一个账户(加账户 / 详情侧栏点同步)。开不动轮时,把名单里有、活轮里没有的账户 `enlist` 进那一轮,只投它们(自动轮照样先把其中数据还新的记 `skipped`);活轮里已有的不动(还 pending 的有人在跑,落过账的刚同步过)。撞上全量轮时一个都不缺,什么都不做 —— 与以前「让开」同一个下场。第一下 enlist 落空(活轮恰好收官 / 过期)再开一次。抢到了却没投出去(投递炸了、cron 后面的组合开轮时炸了、enlist 到一半炸了)一律收尾:自己开的轮带一句话收官,拉进别人轮的记 failed(`abandonClaims`,R2-#4)。
- **cron 投递失败也收尾**:与手动 / 单账户同一个口径 —— 自己开的轮带 `could not queue the sync` 收官,拉进别人轮的账户记 failed。以前只记一行 warn,轮挂着 pending 120s 后念成没有原因的「中断」。
- **`settle` 只做 pending → 终态,且不碰已收官的轮**(`finishedAt is null` + `status = 'pending'`,与 `touch` / `enlist` 同款):同一个账户两条消息可能并发越过 consumer 的「还 pending 吗」(那一读在几十秒的同步之前),后到的那条以前会改写状态、把收官写下的 7 天保留期改回 120 秒。现在先落的算数,测试按真并发钉着。
- **最终失败进死信**(见上文「ack / retry」那一条)。
- **consumer 每次投递开跑前续心跳**,`ROUND_HEARTBEAT_MS` 改由重投链倒推(见上文「代价」第一条)。
- **要投消息的 server fn 不再收 `context`**:`runtime.ts` 新增 `enqueueForUser(build)` —— `asUser` 顺手 provide 一个 `UserJobs` 服务(Tag 不出文件,只出类型,与 `CurrentUser` 同理),`build` 拿到的 userId 只用来填消息体。`syncAccount` / `createAccount` / `createManualActivities` / `updateManualActivity` 回到 `runEffect`,`runTimedForUser` 删除;`startSyncRound` / `startAccountRound` / `refillDailyPrices` 签名里不再有 userId。cron 的 `fanOutUserRounds` 仍自己拿 userId —— 它就是装配点(逐用户 `forUserDb`)。
