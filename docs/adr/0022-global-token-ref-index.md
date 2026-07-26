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

**`namer` / `local_name` 拆两列存**,不是把 `<namer>/<localName>` 整串塞一列:点查走 `(ref, namer)` 主键;整串一列要 `LIKE '<namer>/%'`。与 per-user 的 `token_refs` 同一条理由、同两个词。

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
- **不删行**:下架币的旧映射留着无害,`updated_at` 用来看哪些行这轮没被刷到。
- **已实测**(2026-07-26,`/coins/list?include_platform=true`):响应 **2.64 MB**、**17,841** 个币、**300** 条链、含合约地址的行 24,534 条,其中落在我们追踪的 6 条链上 **14,314 行**(其余 294 条链只计数不产行)。据此定批大小:20 行/语句(80 个绑定参数,稳在 D1 的 100 上限内)× 50 语句/批 = 1000 行/批 → 约 **15 批**。
  实测顺带纠了一处算错:原先按「一批 20 行」切,把那个 100 参数上限当成了**每批**的 —— 它是**每条语句**的,而当时每行本来就是自己一条 INSERT(4 个参数),于是批被切小了 50 倍(14,314 行要 716 次往返)。
  **Workers 上的 parse CPU 仍未测** —— 那要在真 Worker 里跑才有意义(本机 curl 测不出 isolate 的 CPU 预算)。它在 cron 里、不在用户请求路径上,首次真跑时看 Workers Logs 的耗时即可。
