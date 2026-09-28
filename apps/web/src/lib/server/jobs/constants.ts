import { DEFAULT_TOP_N } from "@folio/oracle-basic";

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
 * 它们变了这里要跟着算一遍 —— `tests/server/sync/prices.cases.ts` 按真出网数钉着「≤ 50」。
 */
export const PRICES_IDS_PER_MESSAGE = 1000;
