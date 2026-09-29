import { DEFAULT_TOP_N } from "@folio/oracle-basic";

// 队列那一侧的常量(FOL-86)。

/**
 * 一条消息最多重投几次 —— **与 wrangler.jsonc 各 env 的 `queues.consumers[].max_retries` 必须逐字一致**
 * (tests/queue-config.test.ts 锁着)。consumer 靠它判断「这是最后一次投递」:到了这一次还失败,先自己
 * 收尾(轮里那个账户记成 failed,别让它挂着 pending),再 `retry()` —— 重投次数已经用完,这一下把消息
 * 送进死信队列,留给人看(FOL-86 验收:失败消息进死信可见)。
 */
export const JOB_MAX_RETRIES = 3;

/**
 * 两次投递之间隔多久(秒)—— **与 wrangler.jsonc 各 env 的 `queues.consumers[].retry_delay` 逐字一致**
 * (tests/queue-config.test.ts 锁着)。轮的心跳按它倒推(`sync/round.ts` 的 `ROUND_HEARTBEAT_MS`)。
 */
export const JOB_RETRY_DELAY_SECONDS = 30;

/**
 * 一条 `sync-account` 跑一遍(一次投递)最长多久(毫秒):同步内核对上游 3 次尝试 × 20s 超时 + 退避 ≈ 70s,
 * 留 10s 给 D1 读写与估值。
 */
export const SYNC_ATTEMPT_BUDGET_MS = 80_000;

/** 重投到点之后、队列真把它派出去之前的调度余量(毫秒;不含积压)。 */
export const REDELIVERY_SLACK_MS = 10_000;

/**
 * 一条 `sync-account` 从第一次投递开跑到**最后一次投递收场**最长多久(毫秒):`JOB_MAX_RETRIES + 1` 次投递
 * 各跑满 `SYNC_ATTEMPT_BUDGET_MS`,中间隔 `JOB_MAX_RETRIES` 个重投间隔(`retry_delay` + 调度余量)——
 * 4 × 80 + 3 × (30 + 10) = 440s。前端等单账户同步的上限从它推(`queries/account-sync.ts`,review R2-#3)。
 */
export const SYNC_RETRY_CHAIN_MS =
  (JOB_MAX_RETRIES + 1) * SYNC_ATTEMPT_BUDGET_MS +
  JOB_MAX_RETRIES * (JOB_RETRY_DELAY_SECONDS * 1000 + REDELIVERY_SLACK_MS);

/**
 * 一条消息大约花几次队列操作(写 / 读 / 删各一次)。免费计划一天 10k 次;cron 那一行日志按它记一个估算。
 */
export const QUEUE_OPS_PER_MESSAGE = 3;

/** `Queue.sendBatch` 一次最多收几条(Cloudflare 的硬上限)。超过就分批发。 */
export const QUEUE_SEND_BATCH_MAX = 100;

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
