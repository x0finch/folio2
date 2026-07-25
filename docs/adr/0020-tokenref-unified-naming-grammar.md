# `tokenRef`:代币命名统一成「谁 / 它在那儿叫什么」

Status: accepted。修订 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md) 决策 #2(`TokenRef` 不再是 vendor 引用);聚合原则([ADR 0001](0001-aggregate-by-token-group.md) / [0002](0002-never-merge-by-symbol.md))不变;存储层合表与 mint-on-write 属 [#176](https://github.com/x0finch/folio2/issues/176)。

同一个 token 在不同地方有不同名字,这件事现在被三套东西各说了一遍:`buildTokenKey` 产链上地址串(`eip155:42161/erc20:0x…`)、`refKey` 产数据源串(`coingecko:usd-coin`——跟 `buildTokenKey({cgkId})` 是同一个串,两套实现互不知情)、CEX 三个 connector 什么都不产、持仓退化成裸 symbol。决定收成一个概念 **`tokenRef` = `<谁>/<它在那儿叫什么>`**,**恰好两段**,落进新的零依赖小包 `@folio/oracle-ref`(`packages/oracle/ref`),它只做三件事:造串、拆串、拼回去(造串走 `tokenRef.native/contract/opaque` 构造函数,调用方不手写 `kind`)。左半边是个**不透明的名字,包基本不判断它是链、交易所还是数据源** —— 右半边自己说明了自己(`native` / `erc20:<addr>` / 一个不透明 id),解析不需要这个分类,不透明 id 的归一是产的时候由生产者做的,连平台预热要的「这是不是链」也能从右半边看出来。**唯一的例外是地址大小写**:EVM 的 hex 大小写不敏感、小写成稳定的 key,而 base58 / bech32(Solana、Bitcoin、Tron)**大小写敏感**,小写下去就是个不存在的地址 —— 这一处绕不开 `eip155:` 前缀判断,明写为例外而不是假装没有。左半边取短形(`bitcoin` / `binance` / `coingecko`),只有 EVM 保留 `eip155:<chainId>` —— 于是今天的 EVM 串一个字不变,`chain:bitcoin/native:btc` 变 `bitcoin/native`(尾巴那个 symbol 从来没人读),`coingecko:x` 变 `coingecko/x`。解析结果按右半边形状分三支 + 一个 `unknown`,**永不 throw** —— 但**只认规范形**:旧串一律判 `unknown`,库里的旧串由一次性迁移改写,不靠解析器容旧。

## Considered Options

- **左半边复用 `platformKey` 长形**(`chain:bitcoin/native`、`vendor:coingecko/usd-coin`)—— 左半边直接等于 `platforms.id`,一次 join 出 name+logo。否:串更长更难读,且 CoinGecko 不是 platform(定义 = 持仓所在的链或场馆),硬塞 `vendor:` 前缀是为对齐而扭曲概念。
- **混形**(EVM 带斜杠、`bitcoin:native` 不带)—— 最贴直觉,但解析要按有无斜杠分两条路。否。
- **严格 CAIP-19**(`coingecko:coins/id:usd-coin`)—— 对齐外部标准,但本系统不跟外部交换这个串,写起来纯受罪。否。
- **给左半边建分类表**(链 / 场馆 / 数据源)—— 一度以为短形必须这么做。否:三条动机(解析、归一、平台预热)全都不成立,详见正文。
- **文法完全不动,只收编实现** —— 零迁移。否:`coingecko:x` 没有斜杠正是三套分裂的根,不动它则"统一"只剩类型层。
- **原生币写 CAIP-19 的 `slip44:<coinType>`** 而非保留字 `native` —— 对齐标准。否:coin type 是按**币**编号不是按链,拿 ETH 当 gas 的 L2 都是 60,但 Polygon / BSC / Avalanche / Gnosis / Celo 各有各的号(还有没注册过的链)→ 要建一张 chainId→coinType 表。而每条链只有一个原生币,coinType 完全由左半边决定,在 id 里是**纯冗余** —— 冗余又要查表,就会出现 `eip155:1/slip44:501` 这种语法合法、语义胡说的串,`native` 则不可能写错。
- **NFT / 股票 / 法币命名空间**(`erc721:<addr>/<tokenId>`、`mic:XNAS/ticker:AAPL`、`iso4217:USD`)—— 顺手把文法铺宽。否:都没有消费方(knip 直接判死),且 `iso4217:USD` **没有斜杠**,正是刚被干掉的那个例外;法币在本仓库是展示币种([ADR 0006](0006-multi-currency-display.md))不是持仓。三段的 NFT 串现判 `unknown`,将来真要支持时再扩。

## Consequences

- **新包** `@folio/oracle-ref`:零依赖零 IO。4 个 connector(zerion / coinstats / blockbook / manual)改依赖它,顺手摘掉 `@folio/tokens-basic` shim 的遗留依赖。
- **契约**:`buildTokenKey` / `parseTokenKey` 连同 `oracle-basic/token-key.ts` 整个删除。
- **vendor 引用已溶解**(不再需要改名 `VendorRef`):`TokenRef = { source; identifier }` 与 `refKey` 产的 `coingecko:x` 本就是 tokenRef 的第二种写法 → 类型直接变成串,`refKey`/`parseRefKey` 退场,map key 从 `refKey(ref)` 变成 `ref` 本身。`TokenRef` 这个名字现在只指一件事。
  - **代价(明知接受)**:类型上不再区分「已解析的厂商引用」与「provider 原始命名」—— 两者都是串,`Resolution.ref` 收一个 `binance/USDC` 也能通过编译。换来的是全系统一个身份概念,且解析路径窄(只 `resolveAsset` 一处产)、有测试钉住。
  - **存储层不动**:`token_vendor_ids` / `token_price_history` 仍按 `(vendor, vendorId)` 两列存 —— 那正是它们的列。串在写库前经 `vendorPartsOf` 拆回两段,读出时经 `cgkRef` 拼回。合成一张 `token_refs` 仍属 #176 那一轮。
- **迁移**(难回退):`snapshot_balances.token_key` 两类前缀各一条 `UPDATE`;`token_index` 有 TTL 自愈;`token_vendor_ids` 存的是分列的 `vendor` + `vendor_id`,拼串纯内存 → 零迁移。
- **`platforms.id` 一并迁短形**(`chain:bitcoin` → `bitcoin`,`eip155:<id>` 不变):这样 tokenRef 的左半边**直接就是** `platforms.id`,不用夹一层映射。短形不是新发明 —— 场馆的平台键早就是裸 connectorId(`binance`/`okx`/`manual`,见 `aggregate` 里定平台单元那一步,`exchange:`/`perp:` 前缀在 app 里已无人产出),`connector-platform.ts` 也一直在剥 `chain:` 前缀往短形上凑;迁完可删掉那个 hack 与三处 `chain:` 判断(判「在不在链上」改由 `chainOf` 看 tokenRef 右半边)。`platforms` 是**纯缓存表**(带 `expiresAt`),迁移即 `DELETE FROM platforms` 后自行 warm,无需 `UPDATE`。并入「切 producer + 迁移」那一片,不单开。
- **测试**:迁移前只有 53 行 golden 撑着全系统的代币身份。新包按原则 #2 补:三类形状 build/parse 往返、EVM 地址小写且幂等、**base58 / bech32 地址原样保留**、不透明 id 原样透传、非两段串与旧串判 `unknown`、`unknown` 不抛。
- **CEX 产 ref 已并入本轮**(原计划另立票):`binance/USDC` / `okx/BTC` / `hyperliquid/ETH` —— ADR 0002 最底级 `account:symbol` 兜底升格成正规 ref。**行为变更**:同一交易所跨账户的同名币从此合并成一行(跨交易所仍不合,要合须先各自解析到同一 `tokens.id`)。已知遗留风险:交易所 symbol 会被回收(某币下架后同名被另一项目占用),届时 ref 指向的东西会悄悄变,链地址与 CGK id 无此问题 —— 暂不处理。
- **另立票**:`token_index` + `token_vendor_ids` 合成一张 `token_refs`(与 #176 的「vendor 单向桥」正面碰撞,但只碰存储层,本包不受影响)。
- **词汇也跟着统一**(概念统一之后补的一轮):字段名 `tokenKey` → `tokenRef`(含 `snapshot_balances.token_key` → `token_ref` 与 `token_index.kind` 字面量,迁移 0007);store 方法 `getByTokenKey`/`ensureTokenKey`/`linkTokenKeyToCgk` 同步更名;`TokenSource.source` → **`id`**,与姐妹契约 `BalanceProvider.id`(`"binance"`)对齐 —— 同样是「适配器用小写 slug 标识自己」。**不叫 `name`**(本仓 `name` 一律是展示名),也不叫 `vendor`/`namer`(那会给同一概念再添一个词;`namer` 更是 tokenRef 文法的术语,范围更宽 —— 链也是命名者)。
- **`AssetRef` 只有两个身份字段**:溶解成串后 `tokenKey` 与 `ref` 类型相同、语义相邻,一度给前者改名 `providerRef` 以示区别 —— 但 `ref` **没有任何外部写入方**(全仓只有门面 `createTokens` 自己从 `identifier` 填一处),是内部细节漏进了公开类型。故 `ref` 收进门面内部的 `ResolvableAsset`,公开的 `AssetRef` 只剩 `{ symbol, tokenRef?, identifier? }`,字段名与 `Balance` 对齐。
- **死代码清理**:`CgkCoinId` 品牌类型在溶解后无人使用(knip 抓不到 —— 它从 entry 文件导出,正是 `includeEntryExports: false` 的盲区),删除。
- **CONTEXT.md 词表**:加 `tokenRef` / `namer`,删 `tokenKey` / `refKey`。历史 ADR(0002/0010/0013/0014)里的 `tokenKey` 是当时的决策记录,**不改**。
