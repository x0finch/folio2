# `tokenRef`:代币命名统一成「谁 / 它在那儿叫什么」

Status: accepted,文法经**两轮修订**(本文正文记录的原始决策算第一轮,下方正文与选项一概不改)。

**第二轮**([ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md) / [#192](https://github.com/x0finch/folio2/issues/192),已实现):**`eip155:` 改 `evm:`** —— 本文法早已不是 CAIP(真 CAIP 的比特币是 `bip122:…`),一半标准一半自编更别扭。同时**去掉 `<assetNs>:` 那一段**,形状从三种降到两种。

**第三轮(本轮):把中间那一段收回来,但只留一个文法自己拥有的固定标记。** 第二轮删它的理由之一是「那个词是各 producer 自己编的、**全仓没有任何地方按它分支**」—— 后半句已被证伪:mint 的 symbol 那一档**必须**知道一条 ref 是不是链上合约地址,否则一个 symbol 写着 `USDC` 的山寨合约会被并进真 USDC(见下「第三轮」小节)。前半句仍然成立,所以回来的**不是** `assetNs`,而是值域封闭、由文法定死的 `contract:`。

形状三种:`<namer>/native`、`<namer>/contract:<地址>`、`<namer>/<不透明 id>`。
修订 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md) 决策 #2(`TokenRef` 不再是 vendor 引用);聚合原则([ADR 0001](0001-aggregate-by-token-group.md) / [0002](0002-never-merge-by-symbol.md))不变;存储层合表与 mint-on-write 属 [#176](https://github.com/x0finch/folio2/issues/176)。

---

## 第三轮:为什么把标记收回来

mint 认币是个瀑布:**先按地址查全局映射表,查不到才按 symbol 猜**(ADR 0021 / 0022)。地址是权威答案,symbol 只是猜 —— 顺序不能换,换了就会把假 USDC 并进真 USDC。

第二轮之后有个洞:地址那一档 **miss 时会掉到 symbol 那一档**,而「链上合约地址」和「场馆上架代号」在串上不可分辨。于是一个新部署的山寨合约(全局映射表还没收录、symbol 字段自己填成 `USDC`)会走到 symbol 那一档,被策展表或市值排名判成「有把握」,并进真 USDC。后果:

- 首屏那行 USDC 的总枚数凭空多出一百万,而总值没变 —— 数量 × 单价 ≠ 金额
- **盯市的连接器最惨**:manual / bitcoin 的金额是 `数量 × 源价` 现算的 → 1,000,000 × $1 凭空多出一百万美元
- 认定结果冻进快照、`token_refs` 里那条指向也留着,下次 sync 第一步就命中并早退,**永远不再重判** —— 只能等改绑那张票做 UI 来纠

根子在于 symbol 这条线索的**证据强度按 ref 的形状变**,不按报它的人变:

| ref | symbol 从哪来 | 能当身份线索吗 |
|---|---|---|
| `evm:1/native` + `ETH` | 链本身就是 `evm:1`,原生币唯一 | 可以 |
| `evm:1/contract:0xdead…` + `USDC` | **合约部署者随手填的字符串** | 不行 |
| `binance/USDC` | 币安的上架代号,它不会拿假币占 `USDC` | 可以 |
| `manual/BTC` | 用户自己敲的,那就是他的意图 | 可以 |

标记回来之后,这条规则塌成一句话:

```ts
const canGuess = parsed.kind !== "contract";
```

**考虑过、否掉的替代**:给 connector manifest 加 `identifyBySymbol: boolean`(仿 `valuation` 的自声明)。否 —— 同一个连接器既报原生币也报合约,per-connector 的一位表达不了这个差别,还得再补一句「或者它是原生币」;两个来源判一件事,而那件事本质属于**那条 ref 自己**。标记落在串里则跟着数据走:库里任何一条 ref 自己说明自己,读到它的人不必回头问是谁报的。

**没有回来的东西**:producer 自选那个词。`erc20` / `token` / `spl` 这类变体不存在了 —— 只有 `contract:` 一个值,而且它是文法的常量。也刻意**不叫 `erc20:`**:Solana 上那叫 SPL、Sui 上叫 Coin,写 `erc20` 就是又替 producer 编词。


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

---

## 第三轮的 Consequences

- **形状 2 → 3**:`native` / `contract:<地址>` / `<不透明 id>`;解析产这三支 + `unknown`,永不 throw。构造函数回到三个(`tokenRef.native` / `.contract` / `.opaque`),调用方声明意图、不手写 `kind` —— 也就是第二轮收成一个 `local` 的那一步一并回退。
- **地址归一不变**:EVM 的 hex 小写、base58 / bech32 原样,判据仍看 namer 前缀(`evm:`)。这一处从第一轮起就是明写的例外。
- **七个 producer + 全部 golden fixture 再走一遍**:链上那几个(zerion / coinstats)产 `contract:` 形,场馆与手记不变(它们本来就是不透明 id),blockbook 只产 `native`。这是本 epic 内第三次改 ref 串 —— 库要重建,没有数据迁移成本,但 fixture 与测试的机械改动是实打实的。
- **`global_token_ref_index` 的键跟着带标记**:那张表里全是链上合约,CoinGecko 的转换直接产 `contract:` 形。表本身不变(仍是 `(ref, namer, local_name)`)。
- **mint 的 symbol 闸塌成一句** `parsed.kind !== "contract"`。原本要在 connector manifest 加的 `identifyBySymbol` 字段不用加了,mint 里那句「或者它是原生币」也不用写。
- **「namer 是不是链」仍然不需要**:平台由 provider 随余额直接报(#193),那个问题在展示侧压根不存在;这一轮回来的标记只回答「右半边是不是合约地址」,不回答左半边是什么。
- **代价(明知接受)**:一个概念在文法里留了个位置,而它当前只有一个消费方(mint 的 symbol 闸)。第二轮正是因为「没有消费方」把它删了,这轮因为找到了消费方把它加回来 —— 判断依据是「有没有人按它分支」,那个判断本身是对的,只是第二轮时我没找全。
