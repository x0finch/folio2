// 队列那一侧的常量(FOL-86)。

/**
 * 一条消息最多重投几次 —— **与 wrangler.jsonc 各 env 的 `queues.consumers[].max_retries` 必须逐字一致**
 * (tests/queue-config.test.ts 锁着)。consumer 靠它判断「这是最后一次投递」:到了这一次还失败,就不再
 * `retry()`(那会把消息扔进死信队列、轮里那个账户永远 pending),而是自己收尾后 ack。
 */
export const JOB_MAX_RETRIES = 3;

/** `Queue.sendBatch` 一次最多收几条(Cloudflare 的硬上限)。超过就分批发。 */
export const QUEUE_SEND_BATCH_MAX = 100;

/**
 * `warm-user` 比同一个用户的 `sync-account` 晚投多久(秒)。预热读的是**最新快照**,早于同步落库
 * 就是拿上一小时的持仓去暖价。给足单账户的最坏情形(3 次尝试 × 20s 超时 + 退避 ≈ 70s)再留余量。
 * 晚一点没有代价 —— 它是尽力而为的缓存预热,没人在等它。
 */
export const WARM_AFTER_SYNC_DELAY_SECONDS = 120;

/**
 * 一条 `prices` 消息最多刷几个 token(FOL-87)。**由出网预算倒推,不是随手取的整数**:
 * `refreshStale` 对这批 id 发两条上游端点(价 `/simple/price` + 元信息 `/coins/markets`),
 * adapter 各按 100 个一批切(CoinGecko 的 `IDS_PER_REQUEST`),每发请求至多 2 次尝试
 * (adapter 的 `RETRY_ATTEMPTS`)。1000 个 → 每端点 ≤ 10 发 → 最坏 (10 + 10) × 2 = 40 发,
 * 在免费计划一次调用 50 个外部 subrequest 之内,留 10 发余量。
 *
 * 那两个数住在 adapter 里(app 不认识 CoinGecko),所以这里是**抄过来的推导**;
 * 它们变了这里要跟着算一遍 —— `tests/server/sync/prices.cases.ts` 按真出网数钉着「≤ 50」。
 */
export const PRICES_IDS_PER_MESSAGE = 1000;
