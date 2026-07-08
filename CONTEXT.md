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

**Platform**:
持仓所在的**链或场馆**(chain ∪ venue),HoldingSource 的定位维度。key 文法:`eip155:<chainId>` / `chain:<slug>`(链)、`exchange:<slug>`、`perp:<slug>`(场馆)、`manual`。带 name + logo,来自 CoinGecko(asset_platforms / exchanges / derivatives),manual 用内置图标。**粒度:每条 EVM 链各一个**(`eip155:1`/`eip155:8453`…)。归 `@folio/platforms` 包。
_Avoid_: chain(仅指链时才用)、venue(仅指交易所/perp)、network、Connector(那是账户类型单元,粒度不同)

**Connector**:
可插拔的**账户类型单元** —— 一份 manifest 定义"某类账户怎么建(`account.creds`)+ 想要什么余额(`balance.schema`)+ 用哪些 providers 取数",取代旧的 `accountType`(evm / binance / okx / hyperliquid / bitcoin / solana / sui / cosmos / manual)。**粒度:整个 EVM 是一个** connector(其持仓再散落到多个 Platform)。归 `@folio/connectors` 包。
_Avoid_: Platform(那是持仓的链∪场馆定位维度,1 connector 可对多 Platform)、accountType(旧称)、plugin

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
