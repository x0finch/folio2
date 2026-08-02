# OKX 统一账户:四桶锚点 + cashBal 口径

OKX 与 Binance 的账户模型不同。Binance 是**物理隔离的多钱包**(现货 / 资金 / 理财 / U 本位 / 币本位),各打各的端点;OKX 是**统一账户(Unified Account)**——现货、合约保证金、期权混在一个交易账户里,一个 `/account/balance` 就含全部。现有 okx provider 只拉这个交易账户、且用每币 `eq` 当持有量,导致两个问题:

1. **#259 口径 bug**:统一账户里,一个币作合约保证金时它的 `eq` **含合约未实现盈亏(uPnL)**。用 `eq` 当"持有量" → "我有多少 USDT"被浮盈污染(把还没落袋的合约浮盈算成了 USDT 现金)。
2. **漏账**:OKX 的资产不止交易账户。真实探测(只读 key)显示某账户四桶拆分为 `earn $383,021 / trading $15,544 / funding $94 / classic $0`,而 Folio 只认到 trading——**96% 的钱漏在赚币**里没同步。

**决定:把 OKX 资产模型锚定在官方四桶上,交易账户持有量改用 `cashBal`,并把 earn / funding 补全。** 具体:

- **四桶锚点** —— 以 OKX `asset-valuation` 端点给出的四桶(`classic` / `earn` / `funding` / `trading`)为**权威拆分兼对账锚**,不自造"钱包"维度。**结构化产品与 OKX Pay 不作为独立同步目标**:探测证明它们无公开 REST 端点,且它们的钱本就被 OKX 计进了四桶(结构化→earn/trading,Pay→funding),拉全 earn+funding 即自然覆盖,只是不单独打标签。
- **交易账户(trading 桶)口径** —— 每币持有量取 **`cashBal`(现金余额,不含 uPnL)**,不再用 `eq`,修 #259。合约浮盈**不混进现货**,走「永续」(perp,见下缓做);跨交易所口径统一——所有 CEX 的合约浮盈都在永续,不让 OKX 的藏进 USDT。冻结余额(`frozenBal`)仍计入持有(cashBal 含之)、只额外挂 balance 级 Frozen note。
- **质押凭证不双算** —— 质押产出的凭证币(OKSOL / BETH)作为币**已躺在交易账户里**,数量以交易账户为准;`staking-defi/*/balance` 端点**只取利息/APY 供 note**,不作数量来源(否则同一批质押 SOL 在 trading 桶和 staking 端点各算一遍)。
- **earn 桶** —— savings(活期出借)的币算 spot、数量取 `amt`、进净值,标 `Earn·活期·X% APY` balance 级 note;链上赚币(`staking-defi/orders-active`)一并拉。**拉不全的 earn 子类(定期等)不硬猜端点**,用 earn 桶残差挂**账户级 Note**("还有 $X 赚币未细分")兜底。
- **funding 桶** —— 币算 spot、数量取 `bal`、直接并进代币 Tab 跟同币合并,不标来源(钱包非聚合维度,见 [ADR 0030](0030-cex-multi-wallet-best-effort-sync.md))。**不同桶的同名币相加**(不同的钱),**同批钱跨端点不加**(双算),四桶对账兜住。
- **抽屉分 Tab 的分组标记(`note.group`)** —— 复用 Binance 已有机制(`@folio/connectors-basic` 的 `Note.group`):每条 balance 的 note 带一个**不渲染**的 `group` 串,账户抽屉据此把余额归到不同 Tab(随 note JSON 落库,**零迁移**——ADR 0030「钱包只活抽屉」的最轻落地)。OKX 照四桶标:**trading 不标**(默认主 Tab)、**funding→`"funding"`、earn→`"earn"`**,与 Binance 一字对齐;`group` 与 APY / 来源提示**共用同一个 note**(免费搭车)。**数据层的 group 标记这轮就做**(拉每桶时顺手带上);抽屉里真正渲染这些 Tab 的前端**缓到后续 UI 片**(跟 Binance 抽屉 Tab 同批)——UI 片是纯前端活,不必回头补数据。
- **perp 通路缓做** —— 统一账户的合约浮盈没有干净的独立字段,须解析 `positions` 端点的每笔 `upl` 才能精确拿;探测时该账户**无持仓**、无真实数据可验,故 `perp_equity` / `perp_position` **留作后续独立片**(有真持仓再做、拿真数据验证,不盲写)。**兜底**:检测到 `positions` 非空即挂账户级 Note 提示"检测到合约持仓,浮盈暂未纳入,待永续通路上线补全",不让浮盈悄悄漏。
- **估值不加 ticker 端点** —— trading 桶用自带 `eqUsd/eq` 当市价 × cashBal(零额外请求,保留"OKX 有的币都有价");funding / savings 无自带价、金额小、币主流,交 oracle 兜底。弃用 `eqUsd` 直接当 value(它对应含 uPnL 的 eq)。
- **provider 结构 + 尽力而为** —— 保持单 `okxProvider`,`fetchBalances` 内部并发多端点合并成一份余额(registry「一 connector 选一 provider」不动)。逐端点 try/catch,失败不阻断其余、收进**账户级 Note**(复用 ADR 0030;OKX 错误走 HTTP 200+code 判定,auth 类 50xxx → "权限不足",其余 → "暂时失败")。整次同步整体成功。**所有账户级 Note 走 Binance 已有的账户侧边栏(抽屉)展示位,不新造 UI。**

## Consequences

- **有合约持仓时,单看某个保证金币(如 USDT)的数量,Folio(cashBal)会比 OKX App(eq 权益)少一个浮盈**——这是**有意的口径统一**,浮盈在「永续」里、账户总净值仍与 OKX 一致。可在该币行挂 note 消解困惑。
- **四桶是对账锚**:各端点拉取加总须对得上 `asset-valuation` 的四个数;trading 桶因故意不含 uPnL,对账**容忍一个 uPnL 的偏差**;earn 桶残差进 note。对不上即暴露漏拉。**`asset-valuation` 必须带 `ccy=USD`** —— 该端点**默认按 BTC 计价**,不传就拿到 BTC 数值,与美元口径的余额一比即单位错位、对账形同虚设(真机踩过:earn 锚返回 `6.04`(BTC)、被当美元与拉到的 `$251k` 比,残差恒负 → 该报的缺口不报)。
- **这轮 schema 保持 `Spot`**,不升判别联合;perp 片落地时再改成 `Spot | PerpEquity | PerpPosition`。不为未实现的东西提前改契约。
- **结构化 / Pay 无独立标签,且并非「自然覆盖」——其金额已知,故计进净值(合成聚合行)**:真机验证(账户 333)显示结构化 / 定期赚币的本金**计在 `asset-valuation` 的 earn 桶里,但 `savings/balance` 与 `staking-defi/orders-active` 都拉不到逐笔构成**(无公开端点)。关键区分:**金额(USD)拿得到**(= earn 锚 − 已细分 earn 加总,此例 ≈ **$131k**),**拿不到的是「哪个币、几个、什么 APY」**。因此**把这笔残差造成一条不透明聚合行计进净值**(`okx/custom:EARN-UNCATEGORIZED`,`value`=残差;`custom:` 无注册表背书 → oracle 不并进真币、保留本值),带 balance 级中性 note 说明它是「fixed-term / structured earn,无逐币拆分」。效果:Folio 的 OKX 总额 = `asset-valuation` 权威总额、与 OKX App 对上(此例 $266k → **$397k**)。**只在可信时产**:earn 两桶都拉到 + 无估不出价的 earn 项 + 残差 > 阈值(否则残差不可信、不能污染净值)。要把这 $131k **拆成逐币**仍需另找(可能抓不到的)数据源 —— 那是单独的后续工作。
- **classic 桶仍只挂 Note、不计入**:与 earn 不同,classic(经典账户)Folio 根本不拉、也没有「可直接计入的美元残差」语义那么干净,且经典账户在统一账户用户里少见 → valuation.classic >0 时先挂账户级提示,不合成行。
- 待实现时对 fixture 最终核实的字段语义:`cashBal` vs `eq`、savings `rate` 的年化/日化、staking 凭证与质押端点的数量对应。

关联:#259(口径 bug)、#295(Binance 多钱包 epic,同模式先例)、[ADR 0030](0030-cex-multi-wallet-best-effort-sync.md)(CEX 多钱包尽力而为 + 账户级 Note)。
