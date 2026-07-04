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
