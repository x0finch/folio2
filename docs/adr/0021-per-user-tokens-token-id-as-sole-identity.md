# tokens 收归 per-user,`tokens.id` 是唯一贯穿身份

Status: accepted。推翻 [ADR 0001](0001-aggregate-by-token-group.md)(展示分组)与 [ADR 0017](0017-manual-multi-token-holdings.md)(`manual_token` 独立表);改写 [ADR 0002](0002-never-merge-by-symbol.md)(四级归并键塌成一级);扩展 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md)(内部身份 + per-user 维度);修订 [ADR 0020](0020-tokenref-unified-naming-grammar.md)(语法去掉 `assetNs` 段、`eip155:` → `evm:`)。全局映射表见 [ADR 0022](0022-cgk-refs-global-contract-to-coin-map.md)。见 [#176](https://github.com/x0finch/folio2/issues/176)。

`tokens` 原本是**全局共享的参考缓存**(无 `userId`,原则 #6 的受控例外),身份靠读时解析 `tokenRef` 惰性得出,快照存的是 provider 原样命名。决定把 `tokens` 收归 **user 私有**,`tokens.id` 成为系统内部**唯一**的 token 身份 —— `snapshot_balances`、`token_price_history`、`manual_activity` 全部改成 `token_id` FK,`manual_token` 表并入 `tokens`,`snapshot_balances` 的 `symbol` 与 `token_ref` 两列删掉。语境是自托管、单用户量级:**数据隔离 / 可移植 / 可独立备份删除**比用缓存去重换来的复杂度更值。`tokenRef` 不消失,但退到两个边界 —— 连接器报余额、oracle 问 CoinGecko;`apps/web` 一个字都见不到。

代价是**写路径反转**:快照存 `token_id` 就必须写之前先有 `tokens` 行,身份解析从刻意解耦的读时挪进写时(mint-on-write)。mint 的**逻辑在 oracle**(它懂查表、懂用 provider 元信息建行、懂合并),**编排在 app**(`sync-deps` 里接在 `writeSnapshot` 前面)—— `@folio/sync` 与 `@folio/db` 一个字不改,沿用「依赖注入、app 是编排点」的既有形状。D1 没有交互式事务,mint 必须先查后写,故它与写快照注定是两次独立的批;mint 成功而写快照失败只留下没人引用的 token 行(下次复用),无害。**快照的身份可变、金额不变** —— 后来 CoinGecko 认出某个币时要把历史行的 `token_id` 一并改指,否则单币历史会断成两段。

## Considered Options

- **保留全局 `tokens` 做缓存去重** —— 省 CoinGecko 配额(BTC 全站一份)。否:那正是当前别扭的根 —— 用户实际持有的币混在全局表里,导出 / 删除 / 备份每次都要判归属。单用户自托管下去重省下的量无意义。
- **展示分组(`token_groups`)保留** —— WBTC / BTC.b 等桥接变体归成一行,首屏更干净。否:**WBTC 和 BTC 本来就不该算一行**,它们是不同的东西;那张表的内容全部来自代码里的种子名单,是常量的物化。删表连带删掉 `GROUP_MEMBERSHIP`、`packages/db` 里按 CoinGecko coin id 查名单那一处,以及归并键的 `group:` 那一级。
- **manual provider 保留,报 `folio/tk_7` 这种 ref** —— `BalanceProvider` 契约一个字不改,所有 connector 长一个样。否:`manual_token` 并入 `tokens` 之后,`creds.tokens` 那个 JSON 字段的四个值(symbol / identifier / unitPrice / amount)**全都在真表里了**,provider 变成「app 从表里读 → 塞进 JSON 列 → provider 再读 JSON → map 回来」绕一圈回到原地。删掉 provider,手记快照行由 app 直接从 `tokens` + `manual_activity` 算。`manual` 仍是 connector(图标、账户表单、`mark-to-market` 声明都在)。
- **平台(哪条链)从 `tokenRef` 左半边推** —— 少一个字段,今天就是这么干的。否:手记的 ref 是 `coingecko/<id>`,namer 是数据源不是平台,`platform = namer` 有例外;且语法去掉 `assetNs` 段之后从字符串已看不出形状。改成 **provider 自己报** —— 它报余额时当然知道自己在哪条链,今天从 ref 拆是因为 `Balance` 上没这个字段,是将就。连带好处:「namer 是不是链」这个判断整个不需要了。
- **userId 走 ALS**(仓里已用 `withContext` 带 userId 给日志) —— 调用处一个字不改。否:oracle 现在是数据访问,**拿错用户是最严重的 bug 类别**,值得编译期挡住。改成显式工厂 `oracleFor(userId)`,`requireAuth` 中间件只是把它绑到 ctx 上的糖;cron 没有 auth 上下文,逐用户自己造。
- **先统一 mint 全部账户的 ref、再并发写快照** —— 没有竞态,还能一次批量查。否:要在流水线中间插一道 barrier,牺牲今天「每账户独立落库、一个失败不影响其他」的性质。账户是并发跑的(worker pool),竞态改用 upsert-then-read 幂等解决;批量查在账户内部做已经够(一次 `IN` 覆盖该账户全部 ref)。
- **写数据回填迁移** —— 保住历史。否:直接删库重来。省掉 #176 里最脏的一块(反查 `token_id`、从 creds JSON 里挖手记的 CoinGecko id、处理孤立历史价)。回不来的是历史快照曲线与手记账本;`accounts` 与 `manual_activity` 几乎不受本改动影响(一个改名、一个换外键指向),真要保命可以只删 token 与快照相关的表。

## Consequences

- **表**:删 `token_index` / `token_groups` / `manual_token` / `token_meta` / `fx_rates` / `platforms`;`token_vendor_ids` 改名 `token_refs`(`namer` / `local_name` / `token_id`,主键就是拆开的 tokenRef,拆两列才能让反查 `token_id + namer` 走索引);新增 `cgk_refs`(见 ADR 0022)与 `user_cache(user_id, k, v, expires_at)`(装 warm 前 N 名、汇率、平台名图;消歧候选恒是 warm 集的子集,从同一个 blob 筛,不单独存)。**界线:整份都要用的存 JSON,只挑几行用的写表。**
- **一个 token 多条 ref**:多条链的同一个币是**一个 `tokens` 行 + 多条 `token_refs` 行**,归一靠 `coingecko/<coin_id>` 那条 ref 当锚点。同一个 namer 下允许多条(provider 报了个 CoinGecko 不认识的以太坊合约、按 symbol 并进了 USDC),但 `coingecko` namer 下加部分唯一索引 —— 一个 token 只能对一个 CoinGecko coin,挡住合并写错造成的数据损坏。
- **认币的确定性变了**:按 symbol 消歧从读时重算变成写时定死。好处是稳、快;坏处是**当时认错就一直错着**,不会自己好。沿用今天的置信度闸(市值前 N 名或碾压次席才算有把握,否则各自独立建行、不链 CoinGecko)。**改绑另立票**,但合并的代码路径与自动补链共用,那张票只剩 UI。
- **`symbol` 只有一处**:从 `snapshot_balances` 删掉后改一个币的名字,历史快照全部跟着改(今天只影响新快照)。代价是任何进快照的行都必须先有 `tokens` 行 —— 包括 perp 仓位(照现有规则走:`perp_equity` 按 symbol 认成 USDC 并进 USDC 那行,`perp_position` value=0 不进聚合,建了行也是惰性的)与没认出来的币(没有兜底标签了)。
- **`holdingKey` 整个删掉**:只剩一级之后它等于 `token_id` 本身,不需要函数;单币历史也直接按 `token_id` 匹配。
- **`OVERRIDES`(硬编码的 symbol → CoinGecko ref 表)与 `cgkRef` / `CGK_VENDOR` 搬进 coingecko source**,`oracle/basic` 恢复厂商中立;选币不再把 CoinGecko coin id 交给前端,改传 base64url 编码的 tokenRef(前端原样搬运、不解释),点中不建行、提交才建。
- **导出必须扩**:今天不导 `tokens` 也自洽(快照行自带 `symbol` + `token_ref`、手记数据搭 `account.creds.tokens` 的便车)—— 这两条依赖全砍了,不改就只导出一堆指向空气的 `token_id`。加 `tokens` / `token_refs`(refs 嵌在 token 记录里,同 balances 嵌在 snapshot 记录里)与 `manual_activity`(扁平记录,同 membership);`EXPORT_VERSION` 提到 3,旧文件明确报「太旧」不做兼容。验收口径:**导出的文件能单独导进一个空库,总资产与历史曲线跟原库一致** —— 「可完全隔离、独立成库」只有这一条能验。
- **CoinGecko 调用量随用户数线性放大**(tokens / 现价 / 历史价 / warm 全部 per-user)。已知,单用户无所谓。
- **原则 #6 的例外不消失、但收窄** —— 从「全局参考数据」收成 `cgk_refs` 一张公开知识表,细节见 ADR 0022。
