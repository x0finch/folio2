# `global_token_ref_index`:一张全局的「链上 ref → 某命名者叫它什么」表,cron 每日灌

Status: accepted。支撑 [ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md) 的写路径;是原则 #6「数据访问一律 userId-scoped」保留的例外之一,并把该例外从原来的措辞收窄到**同一类的两张表**(见下「例外的范围」)。分层与可换源见 [ADR 0023](0023-oracle-layering-swappable-source.md)。见 [#176](https://github.com/x0finch/folio2/issues/176)。

> **本 ADR 经一轮评审改写**(原名 `cgk_refs`,列 `(ref, coin_id)`):表名与列名把 CoinGecko 焊死在了存储层,换源(cgk → cmc)就得改表。现改为 vendor 中立的 `(ref, namer, local_name)` —— 用的正是 tokenRef 文法既有的两个词(见 CONTEXT.md「namer」)。**决策的实质没变**,变的是它不再姓某一家。

mint-on-write 之后,「这个合约是哪个币」变成写路径上的阻塞问题。今天这件事靠**逐个合约问上游**(CoinGecko 的 `/coins/{platform}/contract/{addr}`,一次一个地址)解决,能忍是因为它跑在 sync 之后的 `warmTokens` 里、best-effort、内部吞错 —— 撞限流就这轮少认几个币,下次再补。挪到写路径上就糊不过去:首次同步几十个新合约必然撞限流,结果是一大批「没链上上游」的孤立行(没价、没图、多链的 USDC 也不归一),要好几轮 sync 才慢慢好。决定改成 **cron 每日拉一次整份币目录**(CoinGecko 是 `/coins/list?include_platform=true`,一次请求拿到全部币在所有链上的合约地址)灌进一张全局表,**sync 只读本地,零网络请求**。

```sql
global_token_ref_index(
  ref        TEXT NOT NULL,   -- 链上寻址:evm:<chainId>/<addr> / <slug>/<addr>
  namer      TEXT NOT NULL,   -- 别名的命名者:coingecko / coinmarketcap / …
  local_name TEXT NOT NULL,   -- 那个命名者对它的叫法
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ref, namer)
)
```

一行 = 「这条链上的这个地址,在**那个命名者**那里叫这个」。两边都是 tokenRef,同一套文法:

```
evm:1/0xa0b86991…  +  coingecko      →  usd-coin
evm:1/0xa0b86991…  +  coinmarketcap  →  3408
solana/EPjFWdd5…   +  coingecko      →  usd-coin
```

### 例外的范围:两张表,同一个理由

原则 #6 的例外现在含**两张**表(#199 落地时定的):

| 表 | 装什么 |
|---|---|
| `global_token_ref_index(ref, namer, local_name)` | 「链上这个地址在某人那里叫什么」(本 ADR) |
| `token_daily_prices(token_ref, day_bucket, unit_price)` | 「某个币某天值多少」 |

**判据是同一条**:里面一条用户数据都没有、可整表重建、跟任何用户无关、删空只是下一轮慢一点。所以这不是新开一类口子,是同一类多一张表。

历史日价为什么也归这一类、以及为什么按 `token_ref` 而不是 `token_id` 作键(后者是 per-user 的随机 UUID,会让每个用户各存一份 BTC 的历史,而且历史不记是谁给的价、换源后同一条曲线前后半段来自两家),记在 [#199](https://github.com/x0finch/folio2/issues/199) 的正文里。

**这张表没有 `userId`**,因为里面一条用户数据都没有 —— 全是上游的公开知识、可整表重建、删空只是下一轮慢一点。这跟今天别扭的那个例外性质不同:今天是 `tokens` 表**混着存用户实际持有的币**。**它是表不是 JSON blob**,因为读法是「四万行里点查几行」;整份塞成 JSON 就得为查 5 个地址把十几 MB 读出来 parse,Workers 的 CPU 顶不住。反过来 warm 前 N 名整份都要用,那才该是 blob(在 `user_cache` 里)。

## 列名与跨层形状(#228,在 [#227](https://github.com/x0finch/folio2/issues/227) 的评审里定案)

这张表里**有两条 ref**,一开始列名不区分谁是谁,后果是调用点读不懂:

```
chain_ref            evm:1/contract:0xa0b8…   ← 链上寻址。左段 evm:1 本身就是一个命名者(链)
upstream             coingecko                ← 另一个命名者(上游)
upstream_local_name  issued:bitcoin           ← 上游 ref 的 localName 规范形
```

`chain_ref` 与 `upstream` **都是命名者**,原来都叫 `namer` → 一行 `refIndex.lookup(namer, [ref])` 看着像 `namer` 属于 `ref`(那 ref 里不是已经有了吗?),其实一个是链、一个是上游,这一行做的是**换命名者**。改名后自解释;而 `upstream_local_name` 原叫 `local_name`、装的却是裸 coin id(`bitcoin`)而非 tokenRef 的 localName(`issued:bitcoin`),名不副实 —— 改名 + 存规范形一并修。

由此落下两条**通则**(不止这张表):

1. **跨层传 ref 就传整条,落表时才拆。** `TokenRefIndexRow` 两边都是整条 `TokenRef`(`chainRef` / `upstreamRef`),store 落表时才用 `parseTokenRef` 拆成 `(upstream, upstream_local_name)` 两列。右半边(`issued:` 那段)是文法的内部构造,不是接口 —— 给半截会迫使每个调用方知道命名者是谁、自己 `buildRef.issued(namer, …)` 拼回去,那件事就会一路漏出去(#227 已两次踩到:`ManualHolding.ref`、`tokenTicket.decode` 回规范形;这里是第三处,mint 的 `buildRef.issued(namer, byAddress)` 随之消失)。

2. **拆不拆列看查询;一张表里有两条 ref 才给列名加前缀。** 要按左段或右段**单独查** → 拆列;只做**整体等值查** → 一整列。`token_refs`(拆)、`global_token_ref_index`(半拆)、`token_daily_prices`(不拆)三张表按这条量,结构都对。前缀同理:`token_refs` 只有一条 ref → `namer` / `local_name` 不歧义、不加前缀;这张表有两条 → 不加前缀分不清 `local_name` 是谁的,故加 `upstream_`。

**为什么不把 `chain_ref` 掰成 `chain` + `address` 两列**(一度提过,理由是「cron 整表重建 / 链对照失配 / 某条链批量重刷都是按链的操作」)—— 查过代码,三个场景一个都不存在。这张表上一共三个操作:

| 操作 | WHERE | 用到左段单独查吗 |
|---|---|---|
| `lookup` | `upstream = ? AND chain_ref IN (…)` | 不。整串等值 |
| `putAll` | `upstream IN (…)`（差量:keyset 分页扫 + 逐行删/改，见 FOL-68 更新） | 不 |
| `refreshedAt` | `upstream = ?` | 不。筛的是**上游** |

`unmatchedPlatforms` 也是 `toRefIndexRows` 在内存里从 API 响应算的,压根没查库。按上面那条判据,`chain_ref` 只做整体等值查 → 一整列;拆列是 speculative generality。反过来 `upstream` **必须**独立成列:它被单独查两次(`lookup` 的 WHERE、`refreshedAt`),且 PK `(chain_ref, upstream)` 靠它保证「一个地址在一个上游下最多一行」——合成一列就得 `LIKE 'coingecko/%'`,主键也挡不住同一地址在同一上游下冒两个 id。

**迁移是 drop + 重建、不迁数据**:这张表是 cron 一天一次整表重建的纯缓存、无 `user_id`,而且 `upstream_local_name` 的**值格式变了**(裸 `bitcoin` → 规范形 `issued:bitcoin`),纯 rename 会留下错值 —— 直接 `DROP` + `CREATE`,下一次 cron 用正确值自动灌满(首次部署本来就要手动触发一次刷表)。

## Considered Options

- **保持懒查(今天的做法),只是把它挪进写路径** —— 零新增。否:见正文,首次同步体验会明显变差。
- **拉全量后在内存里批量匹配、不落库** —— 一次请求换几十次,也不用新表。否:每次遇到未知合约都要重拉十几 MB;cron 灌表则是一天一次、可预测,且 sync 永远快。
- **表名/列名跟着当前源走(`cgk_refs(ref, coin_id)`,本 ADR 的原方案)** —— 短、直白、当下够用。否:换源要么改表要么再建一张平行表,而「方便换源」是这一层的立身之本(ADR 0023)。多一列 `namer` 换来「加源只加行」,并且换源期间两家可以并存、切换是配置不是迁移。
- **塞进 `user_cache`** —— 少一张表、规则统一。否:三重不对。跟用户无关却要每人一份、cron 还得为每个用户各刷一遍;`user_cache` 是「一个 key 一份 JSON」,点查得把它改成半张关系表;混在一起以后每件事都要判归属(删用户要不要删、导出要不要带)。
- **Workers KV** —— 天生适合这种读多写少的映射,还不占 D1。否:四万条只能一条条写,一次 cron 调用里写不完。D1 `batch()` 分几十批就行。
- **跟每日 sync 共用一个 cron trigger** —— 配置不动,一个入口看得清楚。否:拉几 MB JSON + 写四万行是重活,跟全量 sweep 挤一次调用的 CPU / 时间预算有超预算风险,刷表卡住会拖到 sync 跑不完。拆成两个 trigger(刷表 23:00、sync 00:00),各自一份预算;刷表先跑完,sync 当天就能用上新数据。`controller.cron` 已在记日志,按它分支是一行的事。

## Consequences

- **新币最多滞后一天**(cron 一天一次)。表里没有的才走一次单查兜底,补上一部分;兜底也失败就建只有合约 ref 的 token 行、快照照写,下次 sync 白查一次本地表自动补链(那时是一次**合并**:ref 改指到已有 token 行 + 快照 `token_id` 一并改指 + 旧行没人引用就删)。
- **`token_refs` 不需要 `recheck_at`**:「上游认不认识这个合约」变成查本地表的即时答案,不需要否定缓存计时器。今天那套「孤儿行 / CoinGecko 行 / 复查三态」整个消失,`markCgkChecked` 删掉 —— 一个币有没有被认出来,看它有没有当前源那个 namer 的 ref 行。
- **原生币不在表里**(上游那边 `platforms` 字典为空),它们靠 symbol 认。所以表里全是合约。
- **非 EVM 链要一张显式 slug 对照,且它归 adapter**:EVM 两边都归到 `evm:<chainId>`,靠 `/asset_platforms` 的 `chain_identifier` 对齐、不会歧义;非 EVM 是「连接器说 `solana`」对「上游说什么」,slug 对 slug,**现在三条链恰好一样纯属运气**。「CoinGecko 管 Sui 叫什么」是 CoinGecko 的事 → 对照表连同「两个端点 → 映射行」的纯转换一起住在 `oracle-source-*` 包里,契约层不知道有这回事(ADR 0023)。对不上就是币没价没图还不报错,故转换结果带出失配清单、由 cron 记 warning + 计数(Workers Logs 可查),不做专门 UI —— 没认出来的币在总览里本来就显眼,专门的列表跟改绑那张票一起做更顺。
- **「namer 是不是链」不靠这张表回答了**:原方案想让兜底单查顺带解决它(翻得出 CoinGecko slug 就是链)。#193 之后平台由 provider 随余额直接报、写快照时从命名者算出并落库,这个判断在展示侧压根不存在;写路径要的「这条 ref 在哪条链上」由调用方给(`AssetRef.chain`)。
- **首次部署要先手动触发一次刷表**,否则空表状态下全靠单查兜底,退回今天的样子。
- **差量删下架币**(FOL-68 更新;原为「不删行」):见文末更新一节。
- **已部分实测**(2026-07-26,`vitest-pool-workers` = 真 workerd,但跑在**本机 Miniflare** 上,不是 CF 边缘):
  响应 **2.63 MB**、**17,841** 个币、`/asset_platforms` 列 **461** 条链、产出 **23,004 行**(跳过 1,530 条残缺条目),链对照**零失配**(显式的非 EVM slug 表是全的)。这三项与在哪跑无关,可信。
  **CPU:`JSON.parse` 27ms + 纯转换 22ms ≈ 50ms** —— 同一个 workerd / V8,只是 CPU 是本机的,故为同量级参考而非精确值。**几 MB JSON 的 parse 不构成 CPU 问题**,当初写下这条待测项时担心的那点不成立。
  据此定批大小:20 行/语句(80 个绑定参数,稳在 D1 的 100 上限内)× 50 语句/批 = 1000 行/批 → **24 批**。
  **仍未测:真 D1 的写入耗时。** 本机那次 636ms 是 Miniflare 的本地 SQLite,而远端 D1 是**每批一次网络往返** —— 24 批在生产上会明显更慢,量级得等首次真 cron 跑完看 Workers Logs。网络那 1,861ms 同理不可外推(本机到 CoinGecko ≠ CF 边缘到 CoinGecko)。
  实测顺带纠了两处:① 原先按「一批 20 行」切,把 100 参数上限当成了**每批**的 —— 它是**每条语句**的,当时每行本来就是自己一条 INSERT(4 个参数),于是批被切小了 50 倍(23,004 行要 1,151 次往返);② 先前用本机 curl 估的行数(14,314)偏低 —— 那次只算了 6 条链,而实现覆盖**所有带 `chain_identifier` 的 EVM 链**。

## Update — 差量写(FOL-68,2026-09-03)

**问题**:`putAll` 原本每轮把上游全集(~3 万行)整表 `upsert`,每行 `updated_at` 都刷新 → SQLite 全表重写、D1 计满 ~3 万 `rows_written`/天。而币目录几乎不变(下架/新增每天个位数),这 3 万写基本全是无效重复写,一次吃掉近 1/3 的每日免费额度(CF 告警)。

**改法**:`putAll` 改为**差量写**——keyset 分页(每页 5000 行、按主键序)扫库,与上游全集在内存比对,只落**真变了的行**:改名 `update` / 新增 `insert` / 下架 `delete`。稳态(目录一字没变)写入为 **0**。纯比对逻辑抽成 `diffRefIndexPage` 纯函数,单测四类边界。

**「不删行」→「差量删下架」**:原方案怕误删才不删,靠 `updated_at` 留痕。但删是安全的——上游 `fetchRefIndex` 是「两个全量端点都成功才返回、任一失败整体上抛」,失败根本走不到 `putAll`,所以「成功即完整全集」,库有而全集无 = 真下架。两条护栏:①**空全集 no-op**,绝不拿可疑的空响应清表;②**删除按 `upstream` 作用域**,刷一个命名源只扫/删它自己的行,不碰别家(换源期间两家并存的前提)。

**`refreshedAt` 语义漂移(可接受)**:`= max(updated_at)`,差量后只有变动行才刷 `updated_at`,于是它漂成「上次**有变更**的时间」。唯一消费方是 cron 的一行日志,无逻辑依赖;日志改为额外打出这轮 改/增/删 各几行(稳态应接近 0,长期偏高即信号)。

**效果**:`global_token_ref_index` 的 `rows_written` 从 ~3 万/天 降到接近 0(仅上游真变动行数),每日总写入落回快照那 ~4k + 突发,稳低于 10 万免费额度。
