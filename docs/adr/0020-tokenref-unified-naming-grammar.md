# `tokenRef`:代币命名统一成「谁 / 它在那儿叫什么」

Status: accepted。修订 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md) 决策 #2(`TokenRef` 不再是 vendor 引用);聚合原则([ADR 0001](0001-aggregate-by-token-group.md) / [0002](0002-never-merge-by-symbol.md))不变;存储层合表与 mint-on-write 属 [#176](https://github.com/x0finch/folio2/issues/176)。

同一个 token 在不同地方有不同名字,这件事现在被三套东西各说了一遍:`buildTokenKey` 产链上地址串(`eip155:42161/erc20:0x…`)、`refKey` 产数据源串(`coingecko:usd-coin`——跟 `buildTokenKey({cgkId})` 是同一个串,两套实现互不知情)、CEX 三个 connector 什么都不产、持仓退化成裸 symbol。决定收成一个概念 **`tokenRef` = `<谁>/<它在那儿叫什么>`**,第一个斜杠切分,落进新的零依赖小包 `@folio/oracle-ref`(`packages/oracle/ref`),它只做三件事:切斜杠、解右半边、拼回去。左半边是个**不透明的名字,包不判断它是链、交易所还是数据源** —— 右半边自己说明了自己(`native` / `erc20:<addr>` / 一个不透明 id),解析不需要这个分类,归一是产的时候由生产者做的、解析侧只比字符串,连平台预热要的「这是不是链」也能从右半边看出来。左半边取短形(`bitcoin` / `binance` / `coingecko`),只有 EVM 保留 `eip155:<chainId>` —— 于是今天的 EVM 串一个字不变,`chain:bitcoin/native:btc` 变 `bitcoin/native`(尾巴那个 symbol 从来没人读),`coingecko:x` 变 `coingecko/x`。解析结果按右半边形状分三支 + 一个 `unknown`,**永不 throw** —— 但**只认规范形**:旧串一律判 `unknown`,读旧串是迁移那一片的活,不进本包。本片只立包 —— 不改谁产什么(CEX 照旧不产 ref),不动表结构。

## Considered Options

- **左半边复用 `platformKey` 长形**(`chain:bitcoin/native`、`vendor:coingecko/usd-coin`)—— 左半边直接等于 `platforms.id`,一次 join 出 name+logo。否:串更长更难读,且 CoinGecko 不是 platform(定义 = 持仓所在的链或场馆),硬塞 `vendor:` 前缀是为对齐而扭曲概念。
- **混形**(EVM 带斜杠、`bitcoin:native` 不带)—— 最贴直觉,但解析要按有无斜杠分两条路。否。
- **严格 CAIP-19**(`coingecko:coins/id:usd-coin`)—— 对齐外部标准,但本系统不跟外部交换这个串,写起来纯受罪。否。
- **给左半边建分类表**(链 / 场馆 / 数据源)—— 一度以为短形必须这么做。否:三条动机(解析、归一、平台预热)全都不成立,详见正文。
- **文法完全不动,只收编实现** —— 零迁移。否:`coingecko:x` 没有斜杠正是三套分裂的根,不动它则"统一"只剩类型层。

## Consequences

- **新包** `@folio/oracle-ref`:零依赖零 IO。4 个 connector(zerion / coinstats / blockbook / manual)改依赖它,顺手摘掉 `@folio/tokens-basic` shim 的遗留依赖。
- **契约**:`buildTokenKey` / `parseTokenKey` / `refKey` / `parseRefKey` 全退场;现有 `TokenRef`(= vendor 引用,占着这个名字,约 35 文件)机械改名 `VendorRef`,单独一片;它最终会溶解成 namer=`coingecko` 的一个 tokenRef,另立票。
- **迁移**(难回退):`snapshot_balances.token_key` 两类前缀各一条 `UPDATE`;`token_index` 有 TTL 自愈;`token_vendor_ids` 存的是分列的 `vendor` + `vendor_id`,拼串纯内存 → 零迁移。
- **测试**:现在只有 [53 行](../../packages/oracle/basic/tests/token-key.test.ts) 撑着全系统的代币身份。新包按原则 #2 补:三类形状 build/parse 往返、地址归一幂等、不透明 id 原样透传、旧串判 `unknown`、`unknown` 不抛。
- **另立票**:CEX 产 ref(`binance/USDC`,让 ADR 0002 最底级 `account:symbol` 兜底升格成正规 ref);`token_index` + `token_vendor_ids` 合成一张 `token_refs`(与 #176 的「vendor 单向桥」正面碰撞,但只碰存储层,本包不受影响)。
- **CONTEXT.md 词表**:加 `tokenRef` / `namer`,删 `tokenKey` / `refKey`。
