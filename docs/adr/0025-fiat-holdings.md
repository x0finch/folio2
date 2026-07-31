# 法币持仓:`fiat/issued:<CODE>` 身份、FX 定价、一律计入稳定

Status: accepted。扩展 [ADR 0020](0020-tokenref-unified-naming-grammar.md)(新增 `fiat` 命名者用法,仍走文法固定的 `issued:` 标记)、[ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md)(法币是又一种 per-user Token,同住 `tokens` 表、同走 mint)、[ADR 0006](0006-multi-currency-display.md)(法币持仓的 USD 价复用同一套 FX)。见 [#267](https://github.com/x0finch/folio2/issues/267)。

manual 现在只能记加密资产;需要能记**法定货币现金**(USD/CNY 等)。决定把法币建模成**一种特殊 Token**,身份用新命名者 `fiat/issued:<CODE>`(如 `fiat/issued:USD`),范围锁定与展示币种同一组 **10 种法币**(USD/EUR/GBP/JPY/CNY/KRW/HKD/CAD/AUD/CHF)。它的 USD 价**按 FX 现算**(USD=1,不冻静态价),当 `spot` 同质持仓聚合、计入净值;稳定口径上**所有法币一律算稳定**。选币下拉分 section 呈现(已有代币 / 法币 / Tokens)。

## Considered Options

- **身份用 `custom:`(`manual/custom:USD`)** —— 复用现成那支。否:`custom` 被设计成「无注册表背书、单独一行、无实时价」,法币会拿不到 FX、也不会被认成稳定,与需求正相反。法币要的是「命名者背书」语义,正是 `issued:`。
- **不进 tokenRef / Token 体系,给 manual holding 另开「法币」字段** —— 省一层身份建模。否:要在 mint / 估值 / 聚合 / 选币多处开并行分支,与加密路径割裂。新命名者 `fiat` 让法币复用同一套 mint 与聚合。
- **只有 USD 算稳定、EUR/CNY 不算(FX 敞口)** —— 严格的美元锚。否:产品口径把「稳定」定义为「非加密波动的现金类资产」,法币现金都算(用户拍板)。代价:EUR/CNY 对 USD 会浮动,stableShare 含这部分 FX 敞口,不是严格美元锚 —— 这是有意的取舍。
- **法币计入净值但排除出 Tokens tab(单开「现金」桶)** —— UX 更准(现金≠代币)。否:manual 法币是 `spot`,[ADR 0021](0021-per-user-tokens-token-id-as-sole-identity.md) 之后聚合口径的 spot-only 规则(#129)本就纳入它;单开桶要给聚合再加例外,还要让稳定桶单独找回法币。代价:Tokens tab 会出现现金行,tab 名略微名不副实(以后想改改 tab 名即可)。
- **FX 汇率塞进 `priceOf`、与加密同源** —— 一条价格路径。否:把汇率混进代币价格源,TTL 与语义都不同;改成 revalue 里按 `fiat` 身份分支单独走 FX。
- **选币三 section 互斥去重** —— 同一个币不重复出现。否:去重逻辑不值当,三组各自独立列、同币在两组重现可接受(section 有标题不误导)。

## Consequences

- **身份写进用户数据**:`fiat/issued:<CODE>` 落进 `token_refs` 与 mint 出的 `tokens` 行;日后改身份方案要迁移(故难回退)。
- **mint 认法币**:mint 见 `fiat/issued:<CODE>` → 建 / 取一条 canonical 法币 token 行,`symbol=CODE`,`logo` 取自 `SUPPORTED_CURRENCIES` 的 base64([#268](https://github.com/x0finch/folio2/pull/268))。
- **估值分支**:revalue 按 `fiat` 身份走 FX(USD=1),不冻 `self_price` —— 汇率变则非美元法币的 USD 显示值随之变。
- **稳定判定**:`HoldingLike` 加 `isFiat`(身份驱动),`stable = isFiat || 现有稳定币 symbol 表`;与 [#99](https://github.com/x0finch/folio2/issues/99)(`tokens.is_stablecoin`)方向不冲突,将来可并。
- **范围锁 10 种**:扩展新法币 = 往 `SUPPORTED_CURRENCIES` 加一处(logo + FX 覆盖同时补齐)。
