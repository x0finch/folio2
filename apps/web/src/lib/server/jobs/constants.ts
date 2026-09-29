import { DEFAULT_TOP_N } from "@folio/oracle-basic";

// 后台任务运行器那一侧的常量(FOL-86 起;FOL-100 起活在 Durable Object 的 alarm 里跑,ADR 0058)。

/**
 * 一件活最多**重跑**几次(首跑之外)。运行器靠它认「最后一次」:到了这一次还失败,consumer 先自己收尾
 * (轮里那个账户记成 failed,别让它挂着 pending),再 `retry()` —— 次数用完,运行器把它**埋掉**
 * (留在 DO 存储里、标上死亡时间,给人看),不再跑。
 */
export const JOB_MAX_RETRIES = 3;

/** 第一次重跑前等多久(毫秒)。之后每次翻倍(指数退避,见 `jobRetryDelayMs`)。 */
const JOB_RETRY_BASE_DELAY_MS = 30_000;

/**
 * 第 `attempt` 次跑失败之后,隔多久再跑(毫秒):30s → 60s → 120s。平台对 alarm 自己的重试只有 6 次、
 * 间隔也不由我们定,所以**重试不交给平台** —— alarm 永远正常返回,失败的活由运行器按这里排下一次。
 */
export const jobRetryDelayMs = (attempt: number): number =>
  JOB_RETRY_BASE_DELAY_MS * 2 ** (Math.max(attempt, 1) - 1);

/** 最长那一次重跑间隔(毫秒)—— 轮的心跳按它倒推(`sync/round.ts` 的 `ROUND_HEARTBEAT_MS`)。 */
export const JOB_RETRY_MAX_DELAY_MS = jobRetryDelayMs(JOB_MAX_RETRIES);

/**
 * 一条 `sync-account` 跑一遍(一次投递)最长多久(毫秒):同步内核对上游 3 次尝试 × 20s 超时 + 退避 ≈ 70s,
 * 留 10s 给 D1 读写与估值。
 */
export const SYNC_ATTEMPT_BUDGET_MS = 80_000;

/**
 * 到点之后、运行器真把它跑起来之前的调度余量(毫秒;**不含积压**)。运行器是**一个** DO、一次 alarm 跑
 * 一件活,所以排在前面的活会让后面的晚开跑 —— 单用户、个位数账户时是秒级。
 */
export const REDELIVERY_SLACK_MS = 10_000;

/**
 * 一件活被领走之后「锁」多久(毫秒)。领的那一刻就把次数 +1、把到点时间推到这么久以后:DO 在跑的中途
 * 被驱逐(超 CPU、实例重启)时,这件活不会丢,过了租期照样再跑,而且**那一次算数** —— 一件每次都把 DO
 * 跑崩的活,跑满次数也会被埋掉,不会无限循环。取一次投递的最坏耗时再留余量。
 */
export const JOB_LEASE_MS = SYNC_ATTEMPT_BUDGET_MS + REDELIVERY_SLACK_MS;

/**
 * 一条 `sync-account` 从第一次开跑到**最后一次收场**最长多久(毫秒):`JOB_MAX_RETRIES + 1` 次各跑满
 * `SYNC_ATTEMPT_BUDGET_MS`,中间隔 `JOB_MAX_RETRIES` 个退避间隔(30 + 60 + 120)各加一份调度余量 ——
 * 4 × 80 + 210 + 3 × 10 = 560s。前端等单账户同步的上限从它推(`queries/account-sync.ts`,review R2-#3)。
 */
export const SYNC_RETRY_CHAIN_MS =
  (JOB_MAX_RETRIES + 1) * SYNC_ATTEMPT_BUDGET_MS +
  Array.from({ length: JOB_MAX_RETRIES }, (_, i) => jobRetryDelayMs(i + 1)).reduce(
    (a, b) => a + b,
    0,
  ) +
  JOB_MAX_RETRIES * REDELIVERY_SLACK_MS;

/**
 * 一件活花几次 DO 请求:它自己那一次 alarm(投递那一次 RPC 按批算,不按件)。免费计划一天 10 万次;
 * cron 那一行日志按它记一个估算。
 */
export const RUNNER_ALARMS_PER_JOB = 1;

/** 埋掉的活在 DO 存储里留多久(毫秒)。够人来看一眼,又不让死活无限堆。 */
export const DEAD_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 有到点的活、却这么久(毫秒)没跑过一次 alarm,cron 的戳一下就记一条 warn —— 运行器可能卡住了。
 * 取一次投递最坏耗时的几倍:正常积压到不了这么久。
 */
export const RUNNER_STALL_MS = 15 * 60 * 1000;

/** 运行器只有一个实例,按这个名字取(`idFromName`)。所有用户的活排在同一条线上。 */
export const JOB_RUNNER_NAME = "jobs";

/**
 * 读**最新快照**的那几件(`platforms` / `defi-logos`)比同一个用户的 `sync-account` 晚投多久(秒)。
 * 早于同步落库就是拿上一小时的持仓去暖。给足单账户的最坏情形(3 次尝试 × 20s 超时 + 退避 ≈ 70s)
 * 再留余量。晚一点没有代价 —— 它们是尽力而为的缓存预热,没人在等。
 * 不读快照的(`fx` / `catalogue`)与同步无先后,不延后。
 */
export const AFTER_SYNC_DELAY_SECONDS = 120;

// CoinGecko adapter 每发请求至多试几次(adapter 的 `RETRY_ATTEMPTS`)与目录一页几行
// (`MARKETS_PER_PAGE`)。住在 adapter 里、app 不认识 CoinGecko,所以这里是**抄过来的**
// (与下面 `PRICES_IDS_PER_MESSAGE` 同款);变了要跟着算一遍。
const UPSTREAM_ATTEMPTS = 2;
const CATALOGUE_ROWS_PER_PAGE = 250;

/**
 * 参考层那几件活(FOL-88)一条消息**最坏**打几发上游 —— 免费计划一次调用 50 个外部 subrequest,
 * 每件都远在其下,所以它们不需要像 `prices` 那样切块。**逐件推导**:
 *
 *   · `fx`         `/exchange_rates` 一把给全部币种 → 1 发 × 2 次尝试 = 2
 *   · `platforms`  `/asset_platforms` 一把给整张链表 → 1 发 × 2 = 2(键全新鲜 → 0)
 *   · `catalogue`  `/coins/markets` 前 `DEFAULT_TOP_N`(1000)个、每页 250 → 4 页 × 2 = 8
 *                  (一周 TTL 内 → 0)
 *   · `defi-logos` 只读快照、写缓存 → 0
 *   · `prune-notes` 两条 UPDATE → 0
 *
 * `tests/server/sync/reference.cases.ts` 按真 fetch 数钉着「不超过这里」。
 */
export const REFERENCE_JOB_UPSTREAM_CALLS = {
  fx: 1 * UPSTREAM_ATTEMPTS,
  platforms: 1 * UPSTREAM_ATTEMPTS,
  catalogue: Math.ceil(DEFAULT_TOP_N / CATALOGUE_ROWS_PER_PAGE) * UPSTREAM_ATTEMPTS,
  "defi-logos": 0,
  "prune-notes": 0,
} as const;

/**
 * 一条 `prices` 消息最多刷几个 token(FOL-87)。**由出网预算倒推,不是随手取的整数**:
 * `refreshStale` 对这批 id 发两条上游端点(价 `/simple/price` + 元信息 `/coins/markets`),
 * adapter 各按 100 个一批切(CoinGecko 的 `IDS_PER_REQUEST`),每发请求至多 2 次尝试
 * (adapter 的 `RETRY_ATTEMPTS`)。1000 个 → 每端点 ≤ 10 发 → 最坏 (10 + 10) × 2 = 40 发,
 * 在免费计划一次调用 50 个外部 subrequest 之内,留 10 发余量。
 *
 * 那两个数住在 adapter 里(app 不认识 CoinGecko),所以这里是**抄过来的推导**;
 * 它们变了这里要跟着算一遍 —— `tests/server/sync/prices.cases.ts` 按真出网数钉着「≤ 50」,
 * 包括每一发都把重试用满的最坏情形(尝试次数由测试从 adapter 的真实行为量出来,不抄这里的数)。
 */
export const PRICES_IDS_PER_MESSAGE = 1000;

/**
 * 一条 `daily-prices` 消息(FOL-90)最多发几发**区间请求**(`/coins/{id}/market_chart/range`,
 * 一发覆盖 ≤ `DAILY_FILL_DAYS_PER_CALL`(365)天)。**由出网预算倒推**:每发至多
 * `UPSTREAM_ATTEMPTS`(2)次尝试 → 最坏 8 × 2 = 16 发,远在 50 之内。
 *
 * 没取到 25(= 50 / 2)是因为另一道闸 —— 10ms CPU —— 先到:一发一年就是 365 个点要解析、
 * 365 行要写(多行 INSERT,见 db 的 `writeDaily`)。8 发 ≈ 3k 行,是按「宁可多一条后续消息」
 * 拍的保守值,**没实测过**;FOL-84 的本地 profile 可以校准它。法币一窗两条腿(BTC 该币 + BTC
 * 美元),按 2 发记账。三年的回填一个币是 3 发,几个币一条消息装得下;装不下的由 consumer
 * 投一条带剩余 id 的后续消息接着补。`tests/server/sync/daily-prices.cases.ts` 按真 fetch 数钉着
 * (含每窗重试用满的最坏情形)。
 */
export const DAILY_PRICES_CALLS_PER_MESSAGE = 8;

/** 一条 `daily-prices` 消息体最多带几个 token id(只是消息体上限,出网预算由上面那个管)。 */
export const DAILY_PRICES_IDS_PER_MESSAGE = 1000;

/** `DAILY_PRICES_CALLS_PER_MESSAGE` 的最坏出网数(含重试),测试按它断言。 */
export const DAILY_PRICES_UPSTREAM_CALLS = DAILY_PRICES_CALLS_PER_MESSAGE * UPSTREAM_ATTEMPTS;
