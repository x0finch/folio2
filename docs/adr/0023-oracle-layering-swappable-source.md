# oracle 是一个可换源的服务:契约 / 服务 / 源三层,端口按 info 与价切开

Status: accepted。收紧 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md)(「多源」从「身份中立」推进到「**依赖表层面**中立」);与 [ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md) 同一轮落地,重写 [#176](https://github.com/x0finch/folio2/issues/176) 的参考层。全局映射表见 [ADR 0022](0022-global-token-ref-index.md)。

ADR 0012 说过「vendor 中立」,但只做到了**身份**中立(归并靠 `tokens.id`,不靠某家的 coin id)。**装配**一直不中立:`createTokens` 里那句 `const p = source ?? createCoinGeckoSource({ apiKey })`,一个 `??` 就让服务层永久依赖了 CoinGecko 那个包;`CGK_VENDOR` / `cgkRef` / `OVERRIDES` 住在本该厂商中立的 `oracle-basic` 里;存储层的表名列名也姓 cgk(ADR 0022 原版)。结果是「换源」只在类型上成立:真要接 CoinMarketCap,得改契约、改表、改依赖。

同时读路径把三件事塞进了一个函数 —— `priceOf` 里「读本地 → 判 stale → 回源 → 写回」一气呵成,`priceSeries` 同样。领域意图与缓存编排纠缠,导致 TTL 语义散落、单测必须连着缓存一起测。

决定三条:

**一、三层,靠依赖表强制。** 三层的包结构本来就有(`oracle-basic` 契约 / `oracle` 服务 / `oracle-source-*` 上游 adapter / `oracle-ref` 文法),此前的错是把它们塌进一个包。规矩明写:**服务层的 `dependencies` 里不许出现任何 client 或 source 包**,只留 `oracle-ref`。目录边界挡不住 `import`,依赖表挡得住,而且 reviewer 一眼能看见。

**二、上游与 store 一样,初始化时注入。** 那个 `??` 删掉;`createOracleFor` 收一组同款的**惰性工厂**(`createTokenStore` / `createTokenPriceStore` / `createRefIndexStore` / `createCacheStore` / `createSource`)。`apiKey` 从服务层的 config 里消失 —— 那是 adapter 的事。服务层也不再 re-export `createCoinGecko*Source`。全仓**只有 app 的一个装配文件**同时认识两边(它本来就为 store 而引 `@folio/db`)。

**三、端口按 info 与价切开,缓存编排收一处。** 现有 `TokenStore` 一个接口塞了 info、价、索引、warm 四件事,这是「混在一起」的根。切两个:`TokenStore`(info facet + ref 行 —— 身份与元信息,长 TTL)、`TokenPriceStore`(价 facet + 历史日价 —— 短 TTL、过期不删只标 stale)。SWR 那套「读本地 → stale → 回源 → 写回」抽成服务层一个函数,price / 历史价 / warm 三处共用。

上游那一面**不用新发明**:`TokenMetaSource`(目录/发现面)+ `PriceSource`(点查面)+ `TokenSource = 两面之交` 已经是同一条切分线,Store 侧照抄即可。

**端口后缀从 `Source` 改叫 `Upstream`**(仅新层;老 oracle 不动,#202 就删了):`Store` 与 `Source` 差两个字母、同长度同后缀,在 import 列表里一眼糊,而这两个词恰恰承担着「这次调用会不会出网」这个最需要一眼看清的区别。中文注释本来通篇写「上游」,标识符跟着对上。`@folio/oracle2-upstream-coingecko` 同理。

## Considered Options

- **只把 vendor 名字改中立,装配不动** —— diff 小。否:`??` 一天不删,服务层就一天在 `dependencies` 里写着 CoinGecko;换源仍要改包依赖,「可换」只是措辞。
- **服务层保留默认源(`source ?? 默认`)图调用方省事** —— app 少写一行。否:那一行正是泄漏点。省下的一行换来一条永久依赖,而 app 本来就已经在注 store 工厂,多注一个同款工厂零认知成本。
- **靠 lint / 约定禁止 import,不动包边界** —— 不用挪文件。否:约定挡不住手快,而依赖表是 `pnpm install` 就生效的硬边界,knip 与 CI 也顺带盯着。
- **`TokenStore` 切成四个**(info / 价 / 历史 / 映射) —— 每个接口更瘦。否:服务层要注四个 token 相关工厂,碎得没有回报;「价与历史价」本就同类、共用同一套 SWR 编排,合成一个更诚实。
- **门面按能力切五个子服务**(info / price / history / catalog / identify) —— 最贴「oracle 像个独立服务」这句话。否:项目的子服务粒度是**领域**(ADR 0012 的 `{ tokens, platforms, fx }`),而「info vs 价」的切分点在**端口**上 —— 切端口就已经拿到了想要的分离,再切门面只是把同一件事说两遍,还多出一批新词。
- **每个能力各写一遍缓存编排,不抽 helper** —— 更直白、没有抽象成本。否:TTL 与 stale 语义会有三份,改一处忘两处;抽出来之后领域函数只剩意图,SWR 只测一次。

## Consequences

- **换源是加一个 adapter 包 + 改 app 一行装配**,不碰契约、不碰表、不碰服务层代码。换源期间两家 adapter 可以并存(`global_token_ref_index` 按 `namer` 分行,`token_refs` 同理),切换是配置不是迁移。
- **代币行上不再有带 vendor 名的字段**:`cgkCoinId` 那种写法退场,沿用现有的 `TokenRecord.ref`(`TokenRef | null`,非空 = 当前源认出来了),由 store 按注入的 `source.id` 过滤 ref 行得出。「认没认出来」照旧不存额外状态(ADR 0021)。
- **`OVERRIDES`(symbol → 某家 coin id 的策展小表)搬进 adapter**:它逐条写的都是 CoinGecko 的 coin id,留在契约层就是硬编码某一家。服务层收一个中立的 `Readonly<Record<string, string>>`。
- **非 EVM slug 对照 + 「两个端点 → 映射行」的纯转换住进 adapter**(ADR 0022):契约层不知道上游有几个端点、返回什么形状。
- **服务层的测试不需要任何 vendor**:注内存假 store + 假 source 即可,本来就是这么写的;区别是现在**连依赖都没有**,不是靠自觉不 import。
- **全局维护任务不挂 per-user 门面**:刷 `global_token_ref_index` 与 userId 无关,单独一个不带 user 的工厂给 cron 用,不必先假造一个用户。
- **代价:多一层装配噪音**。app 的 oracle 装配文件从注 4 个工厂变成注 5 个,且要显式 import adapter 包。明知接受 —— 这一个文件的显式,换来其余所有文件的中立。
- **过渡期多三个临时包名**(`@folio/oracle2-basic` / `@folio/oracle2` / `@folio/oracle2-upstream-coingecko`),#202 那片改名接管 `oracle-basic` / `oracle` / `oracle-upstream-coingecko` 后消失。
