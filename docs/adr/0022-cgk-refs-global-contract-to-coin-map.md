# `cgk_refs`:一张全局的「链上地址 → CoinGecko coin」表,cron 每日灌

Status: accepted。支撑 [ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md) 的写路径;是原则 #6「数据访问一律 userId-scoped」**唯一保留的例外**,并把该例外从原来的措辞收窄到这一张表。见 [#176](https://github.com/x0finch/folio2/issues/176)。

mint-on-write 之后,「这个合约是哪个币」变成写路径上的阻塞问题。今天这件事靠**逐个合约问 CoinGecko**(`/coins/{platform}/contract/{addr}`,一次一个地址)解决,能忍是因为它跑在 sync 之后的 `warmTokens` 里、best-effort、内部吞错 —— 撞限流就这轮少认几个币,下次再补。挪到写路径上就糊不过去:首次同步几十个新合约必然撞 CoinGecko 限流,结果是一大批「没链上 CoinGecko」的孤立行(没价、没图、多链的 USDC 也不归一),要好几轮 sync 才慢慢好。决定改成 **cron 每日拉一次 `/coins/list?include_platform=true`**(一次请求拿到全部币在所有链上的合约地址)灌进一张 `cgk_refs(ref PK, coin_id, updated_at)`,**sync 只读本地,零网络请求**。

**这张表没有 `userId`**,因为里面一条用户数据都没有 —— 全是 CoinGecko 的公开知识、可整表重建、删空只是下一轮慢一点。这跟今天别扭的那个例外性质不同:今天是 `tokens` 表**混着存用户实际持有的币**。**它是表不是 JSON blob**,因为读法是「四万行里点查几行」;整份塞成 JSON 就得为查 5 个地址把十几 MB 读出来 parse,Workers 的 CPU 顶不住。反过来 warm 前 N 名整份都要用,那才该是 blob(在 `user_cache` 里)。

## Considered Options

- **保持懒查(今天的做法),只是把它挪进写路径** —— 零新增。否:见正文,首次同步体验会明显变差。
- **拉全量后在内存里批量匹配、不落库** —— 一次请求换几十次,也不用新表。否:每次遇到未知合约都要重拉十几 MB;cron 灌表则是一天一次、可预测,且 sync 永远快。
- **塞进 `user_cache`** —— 少一张表、规则统一。否:三重不对。跟用户无关却要每人一份、cron 还得为每个用户各刷一遍;`user_cache` 是「一个 key 一份 JSON」,点查得把它改成半张关系表;混在一起以后每件事都要判归属(删用户要不要删、导出要不要带)。
- **Workers KV** —— 天生适合这种读多写少的映射,还不占 D1。否:四万条只能一条条写,一次 cron 调用里写不完。D1 `batch()` 分几十批就行。
- **跟每日 sync 共用一个 cron trigger** —— 配置不动,一个入口看得清楚。否:拉几 MB JSON + 写四万行是重活,跟全量 sweep 挤一次调用的 CPU / 时间预算有超预算风险,刷表卡住会拖到 sync 跑不完。拆成两个 trigger(刷表 23:00、sync 00:00),各自一份预算;刷表先跑完,sync 当天就能用上新数据。`controller.cron` 已在记日志,按它分支是一行的事。

## Consequences

- **新币最多滞后一天**(cron 一天一次)。`cgk_refs` 里没有的才走一次单查兜底,补上一部分;兜底也失败就建只有合约 ref 的 token 行、快照照写,下次 sync 白查一次本地表自动补链(那时是一次**合并**:ref 改指到已有 token 行 + 快照 `token_id` 一并改指 + 旧行没人引用就删)。
- **`token_refs` 不需要 `recheck_at`**:「CoinGecko 认不认识这个合约」变成查本地表的即时答案,不需要否定缓存计时器。今天那套「孤儿行 / CoinGecko 行 / 复查三态」整个消失,`markCgkChecked` 删掉 —— 一个币有没有被认出来,看它有没有 `namer='coingecko'` 的 ref 行。
- **原生币不在表里**(CoinGecko 那边 `platforms` 字典为空),它们靠 symbol 认。所以表里全是合约。
- **非 EVM 链要一张显式 slug 对照**:EVM 两边都归到 `evm:<chainId>`,靠 `/asset_platforms` 的 `chain_identifier` 对齐、不会歧义;非 EVM 是「连接器说 `solana`」对「CoinGecko 说什么」,slug 对 slug,**现在三条链恰好一样纯属运气**。对不上就是币没价没图还不报错,故 sync 里记一条 warning + 计数(Workers Logs 可查),不做专门 UI —— 没认出来的币在总览里本来就显眼,专门的列表跟改绑那张票一起做更顺。
- **兜底单查顺带解决了「namer 是不是链」**:把 `evm:1` 翻成 CoinGecko 的 `ethereum` 翻得出来就是链,翻不出来就不是。判断白送,不用额外名单 —— 这也是 ADR 0020 去掉 `assetNs` 段之后原本要补的那个判据。
- **首次部署要先手动触发一次刷表**,否则空表状态下全靠单查兜底,退回今天的样子。
- **不删行**:下架币的旧映射留着无害,`updated_at` 用来看哪些行这轮没被刷到。
- **待实测**:`/coins/list?include_platform=true` 的响应到底多大、Workers 上 parse 掉多少 CPU(几 MB 量级,好在它在 cron 里不在用户请求路径上);`cgk_refs` 到底几万行,决定分几批 `batch()` 写。
