# Folio — Domain Language

Folio 是自托管加密组合追踪器:把链上钱包、CEX、永续 DEX、手动资产汇成一个仪表盘。本词汇表只收 Folio 特有概念,不收通用编程术语。

## Language

### 代币身份

**Token**:
系统认识的单个代币 —— 一个 CoinGecko coin,或一条 provider 孤儿记录(CGK 未收录)。"canonical token" 专指这个(单个币),不指分组。
_Avoid_: asset, coin(泛指时)

**TokenGroup**:
首屏聚合行的身份单位 —— 产品自有的展示家族,可跨多个 Token(如 USDT 家族含 tether + usdt0 + 桥接变体)。没有分组的 Token = 自身单例组。
_Avoid_: CanonicalHolding, canonical token(组不是"单个规范币")

**tokenKey**:
Balance 携带、也是代币参考层索引键的**代币寻址标识**(CAIP-19 文法:`eip155:…/erc20:…` / `chain:…/token:…` / `native` / `coingecko:…`)。数据源给的**无歧义**寻址;拿不到时为空(退化按 symbol 解析)。
_Avoid_: tokenIdentifier, impl key, caip19(旧称,已统一)

### 持仓与聚合

**Balance**:
provider 报出的单个持仓 —— 属于某账户的某次快照,扁平结构(symbol/amount/value/price/kind/tokenKey)。
_Avoid_: holding(那是聚合后的)

**Holding**:
首屏的一个聚合行 —— 一个 TokenGroup 的总额 + 其各持有点明细。按 TokenGroup 聚合,Token 是组的成员。
_Avoid_: CanonicalHolding, position

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
一个 note = **固定结构**的一段:`{ title, icon?, content }`;`content` 为纯文本(`string`)或行列表(`NoteRow[] = { label, value?, unit?, href? }`);`icon` 为 5 个中性状态名(info/success/warning/error/help)。**无 `type` 画法、无 `format` 枚举**(旧 DetailBlock 词汇表已弃)。数字即数字,locale 格式化由前端注入的 `formatNumber` 做;label/title 英文字面(结构保留,可后加 i18n)。类型在 `@folio/connectors-basic`,渲染在 `@folio/notes-react`(`NoteView` 单段 / `NoteIndicator` balance 图标+popover / account 手风琴)。
_Avoid_: `type`/`format` 词汇表(过度设计,已弃)、markdown、在段里放函数

**Platform**:
持仓所在的**链或场馆**(chain ∪ venue),HoldingSource 的定位维度。key 文法:`eip155:<chainId>` / `chain:<slug>`(链)、`exchange:<slug>`、`perp:<slug>`(场馆)、`manual`。带 name + logo,来自 CoinGecko(asset_platforms / exchanges / derivatives),manual 用内置图标。**粒度:每条 EVM 链各一个**(`eip155:1`/`eip155:8453`…)。归 `@folio/platforms` 包。
_Avoid_: chain(仅指链时才用)、venue(仅指交易所/perp)、network、Connector(那是账户类型单元,粒度不同)

**Connector**:
可插拔的**账户类型单元** —— 一份 manifest 定义"某类账户怎么建(`account.creds`)+ 想要什么余额(`balance.schema`)+ 用哪些 providers 取数",取代旧的 `accountType`(evm / binance / okx / hyperliquid / bitcoin / solana / sui / cosmos / manual)。**粒度:整个 EVM 是一个** connector(其持仓再散落到多个 Platform)。归 `@folio/connectors` 包。
_Avoid_: Platform(那是持仓的链∪场馆定位维度,1 connector 可对多 Platform)、accountType(旧称)、plugin

### 分析:分布 / 组成 / 维度

**Dimension(分析维度)**:
组合金额被分组归拢的轴 —— `token`(按代币)/ `platform`(按链∪场馆,即 [Platform])/ `type`(按 [kind] + 稳定币细分)/ `account`(按账户)。同一套维度供 Allocation 与 Composition 复用。
_Avoid_: category(那易与 CGK 分类混)、group(那是用户自定义的账户分组 TokenGroup / accountGroups)

**Allocation(当下分布)**:
**最新快照**下按某 Dimension 的金额占比拆分(Insights 环形 + 图例)。只回答「此刻各占多少」。
_Avoid_: Composition(那是随时间的)、breakdown(泛指)

**Composition(随时间组成)**:
组合净值**随时间**按某 Dimension 的堆叠拆分(Insights 堆叠面积图)。历史各点用 `snapshot_balances` 冻结值分桶,**最新点**用 overview 的逐-balance 实时值分桶(∴ Σ 桶 = hero 实时总额)。与 Allocation 的分野:Allocation 是「此刻切一刀」,Composition 是「结构随时间演变」。
_Avoid_: trend(那专指总净值单线)、history(泛指)

**Stablecoin(稳定币)**:
经 CoinGecko 分类(`category=stablecoins`)判定的 [Token],落 `tokens.is_stablecoin`(ADR 0016)。驱动 `type` 维的 Stablecoin 桶与 hero 稳定币占比;判定 **kind 先行**(DeFi/Perp 头寸内的稳定币不入此桶)。CGK 未收录的孤儿 token 一律非稳定币。
_Avoid_: stable(缩写,正式词用 Stablecoin)、按 symbol 硬判(已否,见 ADR 0016)

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
