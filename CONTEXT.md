# Folio — Domain Language

Folio 是自托管加密组合追踪器:把链上钱包、CEX、永续 DEX、手动资产汇成一个仪表盘。本词汇表只收 Folio 特有概念,不收通用编程术语。

## Language

### 代币身份

**Token**:
**该 user 认识的**单个代币,`tokens.id` 是它在系统内部唯一的身份(ADR 0021)。孤儿币、手记自定义币都自然落在这个 user 的 Token 集里 —— 「有没有被 CoinGecko 认出来」不是它的一种状态,而是看它有没有一条 `coingecko` 命名的 tokenRef。
_Avoid_: asset, coin(泛指时)、canonical token(不再需要跟"分组"区分)、TokenGroup(展示分组已作废,见 ADR 0021)

**tokenRef**:
代币的**外部命名法**(ADR 0020,文法经四轮修订):`<namer>/<localName>`,恰好两段,第一个斜杠切分。表达「**谁**、管这个 token 叫**什么**」——
`evm:42161/contract:0xaf88…`、`bitcoin/native`、`coingecko/issued:usd-coin`、`binance/issued:USDC`、`manual/custom:USDC`、`fiat/issued:USD`。
localName 四种形状,**每种都有标记**:`native`(保留字,原生 gas 币)、`contract:<地址>`(链上合约)、`issued:<标识>`(命名者背书的标识:场馆代号 / 上游 coin id / 货币码)、`custom:<名字>`(调用方自造、**无注册表背书**,如用户手敲 symbol)。解析是白名单,读不懂一律判 `unknown`(兜底 = 挡住,漏标记往"不可信"倒)。
一个 Token 可有多条 tokenRef(每个命名者一条),故是多对一 —— 多条链上的同一个币就是一个 Token + 多条 tokenRef。
它**不是**内部身份(那是 `tokens.id`),只在两个边界出现:连接器报余额、oracle 问 CoinGecko;`apps/web` 见不到。
文法 + 归一由 `@folio/oracle-ref` 独占实现:`TokenRef` = 串(系统里流通的),`TokenRefParts` = 拆开的结构。
_Avoid_: tokenKey / refKey(旧称,已退场)、caip19、impl key、tokenIdentifier、把它当身份

**namer**:
tokenRef 的左半边 = **命名者**,可以是链(`evm:1` / `bitcoin`)、场馆(`binance`)、数据源(`coingecko`)或 `fiat`(为 ISO 货币码背书,见 Fiat 条)。对 `@folio/oracle-ref` 不透明,包不判断它属于哪类。
**跟 Platform 只是常常重合,不等同** —— 手记的 ref 是 `coingecko/<id>`,namer 是数据源而它的 Platform 是 `manual`。所以 Platform 由 provider 直接报,不从 namer 推(ADR 0021)。
_Avoid_: namespace, platformKey(那是 Platform 的键,两个概念)

**Fiat(法币持仓)**:
用户持有的**法定货币现金**(USD/CNY/EUR… 与展示币种同一组 10 种),作为一种特殊 **Token**:身份是 `fiat/issued:<CODE>` 的 tokenRef —— namer=`fiat`,命名者为 ISO 货币码背书(不是手敲无背书的 `custom`)。与加密 Token 同住 `tokens` 表、同走 mint;当 `spot` 同质持仓聚合、计入净值;USD 价按 FX 现算(不冻静态价);稳定口径上**所有法币都算稳定**。
_Avoid_: cash(口语)、Display currency(那是展示口径/FX,不是持仓)、custom token(法币有背书,custom 无)

### 持仓与聚合

**Balance**:
provider 报出的单个持仓 —— 属于某账户的某次快照,扁平结构(symbol/amount/value/price/kind/tokenRef/platform)。落库时 symbol 与 tokenRef 不存(名字归 Token 那一处、身份换成 `token_id`),platform 存(见其条目)。
_Avoid_: holding(那是聚合后的)

**Holding**:
首屏的一个聚合行 —— 一个 **Token** 的总额 + 其各持有点明细。归并只按 `tokens.id` 一条(ADR 0002 的四级键在 ADR 0021 塌成一级),绝不按裸 symbol。
_Avoid_: CanonicalHolding, position, TokenGroup(展示分组已作废)

**HoldingSource**:
一个 Holding 里的单个持有点 = 某账户在某平台上的这笔持仓(链×账户 / 交易所 / 永续 / manual)。
_Avoid_: source(泛指时)

**kind(资产类别)**:
Balance 的粗粒度**资产类别**判别式,唯一职责是驱动**跨 connector 的公共逻辑**:聚合口径(进不进首屏同质加总)、净值不变量(哪行承载 value)、主表/分区路由。**不承载渲染差异**(那是 note 的事)。四类:`spot`(同质代币,含 BTC / CEX 现货 / 手录)、`defi`(协议仓位)、`perp_equity`(永续净值行)、`perp_position`(单永续仓位)。
_Avoid_: type(那是 connectorId / 旧 accountType)、asset / chain / source(kind 不按资产/链/来源切)、「独有渲染契约」(旧定义,已弃)

**meta(类型化行为 meta)**:
Balance 上随 `kind` 精确的**类型化**结构,只放**共享逻辑 / 跨 provider 视图会结构化读**的字段(defi 的 protocol/positionType;perp 的净值与仓位字段)。强类型、穷尽 `switch(kind)`、禁 `as` cast。`spot` 无 meta。
_Avoid_: note(那是展示层,无共享逻辑读)、开放 `Record`(meta 恒 typed)

**note(展示 note)**(ADR 0011,取代旧 detail/DetailBlock):
provider 专属、**仅供展示、无共享逻辑读**的分段,分**两级**:**account 级** `Note[]`(整钱包 / xpub:BTC 未确认 / 派生地址 / 收款指引)随 `fetchBalances` 顶层返回、落 `snapshots.note`;**balance 级**单个 `Note`(这笔持仓:CEX 锁仓 / 冻结)挂 `Balance.note`、落 `snapshot_balances.note`。将来 staking 到期、减半日期、LP 底层币、健康度… 按语义择级挂。
_Avoid_: meta(那是共享逻辑读的 typed 层)、per-kind 新增(展示细节不再开新 kind)、markdown 字符串(丢 i18n/币种/结构/安全,#68 已否)、memo(那是 manual 账本的**用户手写备注**,另一回事)

**Note(展示分段)**(ADR 0011):
一个 note = **固定结构**的一段:`{ title, icon?, content }`;`content` 为纯文本(`string`)或行列表(`NoteRow[] = { label, value?, unit?, href? }`);`icon` 为 5 个中性状态名(info/success/warning/error/help)。**无 `type` 画法、无 `format` 枚举**(旧 DetailBlock 词汇表已弃)。数字即数字,locale 格式化由前端注入的 `formatNumber` 做;label/title 英文字面(结构保留,可后加 i18n)。类型在 `@folio/connectors-basic`,渲染件在 `apps/web/src/components/notes/`(`NoteView` 单段 / `NoteIndicator` balance 图标+popover / account 手风琴;原 `@folio/notes-react` 包已迁入 web,见 #128)。
_Avoid_: `type`/`format` 词汇表(过度设计,已弃)、markdown、在段里放函数

**Platform**:
持仓所在的**链或场馆**(chain ∪ venue),HoldingSource 的定位维度,**由 provider 随每笔 Balance 直接报**(ADR 0021)。key 一律短形:`evm:<chainId>` / `<slug>`(链)、`binance` / `okx` / `hyperliquid` / `manual`(场馆,即 connectorId)。链的 name + logo 来自 CoinGecko asset_platforms,场馆的来自 connector manifest 自带。**粒度:每条 EVM 链各一个**(`evm:1` / `evm:8453`…)。归 `@folio/oracle`(原独立的 `@folio/platforms` 包已并入,ADR 0012)。
_Avoid_: chain(仅指链时才用)、venue(仅指交易所/perp)、network、Connector(那是账户类型单元,粒度不同)、`chain:`/`exchange:`/`perp:` 前缀(旧长形,已退场)

**Connector**:
可插拔的**账户类型单元** —— 一份 manifest 定义"某类账户怎么建(`account.creds`)+ 想要什么余额(`balance.schema`)+ 用哪些 providers 取数",取代旧的 `accountType`(evm / binance / okx / hyperliquid / bitcoin / solana / sui / cosmos / manual)。**粒度:整个 EVM 是一个** connector(其持仓再散落到多个 Platform)。归 `@folio/connectors` 包。
_Avoid_: Platform(那是持仓的链∪场馆定位维度,1 connector 可对多 Platform)、accountType(旧称)、plugin

**钱包(Wallet)**:
一个 CEX 账户**内部的隔离子账户** —— Binance 的现货 / U 本位合约 / 币本位合约 / 资金 / 理财各是一个 Wallet(OKX:统一交易账户 / 资金 / 理财)。一次同步用**同一把 key** 并发拉该账户名下的多个 Wallet(**尽力而为**:某个 Wallet 拉不到不阻断其余,失败收进**账户级 Note**)。**是账本/展示维度,不是聚合维度** —— 主页仍按 `token_id` 把各 Wallet 的同币加总,Wallet 拆分只在账户抽屉的分 Tab(现货 / 合约)里可见,不进 Platform / HoldingSource 键。某 Wallet 的读权限缺失(如没勾 Binance 的 Futures)→ 该账户为**部分授权**:creds 字段仍齐(**≠ needsCredentials**),失败 Wallet 走 Note 提示补权限。
_Avoid_: sub-account(交易所 API 的 subaccount 是**独立 API 主体**、另一把 key —— 不是这个)、account(那是 Folio 的账户,Wallet 是它的内部隔离)、钱包(泛指链上 EVM 钱包时才用)

### 账户分组与视图

**Portfolio(组合)**:
账户的**硬隔断归属** —— 每个账户恰属一个 Portfolio(1:1),像工作区。全站作用域(总额 / 代币 / 曲线 / Insights)由当前选中的 Portfolio 界定;每 user 恰一个默认 Portfolio(ADR 0033)。
_Avoid_: group、accountGroups(旧称,已删)、workspace

**Tag(标签)**:
账户的**软标签** —— 一个账户可挂多个(M:N),做**横切分组**用(如「长线」「链上挖矿」)。归属某个 Portfolio(账户只能打其所在 Portfolio 的 Tag)。是 [Portfolio] 内的再分组,不是硬隔断。
_Avoid_: group、label(那是账户显示名 `accounts.label`)、category

**自定义 Tab(tab pin)**:
首页上一个**指向单个 [Connector] 或单个 [Tag] 的固定快捷入口**(pin) —— 名字与颜色借用所指对象,不自存;点它把首页作用域收窄到「当前 [Portfolio] 内、属于该 Connector / 该 Tag 的账户」。每 user 至多固定 3 个。展示用**按小计倒序的 section list**(区别于默认 / Portfolio 视图仍用的现货 / 永续 / DeFi 子 Tab)。
_Avoid_: saved view(它不是可组合多条件的一等视图,只是薄指针)、filter preset

### 分析:分布 / 组成 / 维度

**Dimension(分析维度)**:
组合金额被分组归拢的轴 —— `token`(按代币)/ `platform`(按链∪场馆,即 [Platform])/ `type`(按 [kind] + 稳定币细分)/ `account`(按账户)。同一套维度供 Allocation 与 Composition 复用。
_Avoid_: category(那易与 CGK 分类混)、group(用户自定义账户分组现由 [Tag] 表达;旧的 accountGroups 已于 #336 删除)

**Allocation(当下分布)**:
**最新快照**下按某 Dimension 的金额占比拆分(Insights 环形 + 图例)。只回答「此刻各占多少」。**manual 例外**(ADR 0018):manual 账户不写快照,其「此刻」由现造的合成余额注入 overview(ADR 0021 之后由 app 从 `tokens` + `manual_activity` 直接算,不再经 `creds.tokens` 那个物化字段),故仍进 Allocation。
_Avoid_: Composition(那是随时间的)、breakdown(泛指)

**Composition(随时间组成)**:
组合净值**随时间**按某 Dimension 的堆叠拆分(Insights 堆叠面积图)。历史各点用 `snapshot_balances` 冻结值分桶,**最新点**用 overview 的逐-balance 实时值分桶(∴ Σ 桶 = hero 实时总额)。与 Allocation 的分野:Allocation 是「此刻切一刀」,Composition 是「结构随时间演变」。**manual 例外**(ADR 0018):manual 不写快照,故只进**最新点**(经 overview 注入),**历史各点缺席** manual,直到 T5(compute-on-read 从账本重算历史)补全。
_Avoid_: trend(那专指总净值单线)、history(泛指)

**Stablecoin(稳定币)**:
驱动 `type` 维的 Stablecoin 桶与 hero 稳定币占比的 [Token] 判别;判定 **kind 先行**(DeFi/Perp 头寸内的稳定币不入此桶)。**目标**是经 CoinGecko 分类(`category=stablecoins`)判定并落库(ADR 0016);**当前实现是 `hero-stats.ts` 里一份临时固定 symbol 清单**(#102 未落地,`tokens` 上还没有那一列)。
_Avoid_: stable(缩写,正式词用 Stablecoin)

### 计价与展示币种

**Base currency(计价基准)**:
USD。全站**存储 / 聚合 / provider** 一律以 USD 计价;非美元只是展示层的一次换算,不改任何存储值。
_Avoid_: 把 Display currency 也叫 base

**Display currency(展示币种 / 偏好币种)**:
用户选择的、金额呈现所用的币种 —— **法币或加密**(如 EUR、JPY、BTC、ETH)。按浏览器保存(cookie `folio_currency`),非账户级。仅在展示层生效。
_Avoid_: base currency(那恒为 USD)、locale(那管语言/分隔符,与币种正交)

**FX rate(汇率)**:
`usd_per_unit` —— **1 单位展示币种的美元价**(法币与加密同义)。展示值 `= value / rate`(`value` 为持仓的 USD 权威值)。源自 CoinGecko `/exchange_rates`(以 BTC 为基准反算,BTC 约掉)。
_Avoid_: 反向表述(不用"每美元多少目标币")
