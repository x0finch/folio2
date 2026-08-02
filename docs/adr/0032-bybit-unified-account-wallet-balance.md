# Bybit 统一账户:walletBalance 口径 + 三桶(交易 / 资金 / 赚币)

Bybit 与 OKX 的账户模型高度相似,都是**统一账户(Unified Trading Account, UTA)**——现货、合约保证金、浮盈混在一个交易账户里——外加一个独立的**资金账户(Funding)**和一批 **Earn** 产品。首次接入 Bybit,拿真实只读 key 探测(账户约 $81.5k)确定了口径。若照搬「取账户级 total」或「用每币 `equity`」会带来两个与 OKX 同源的坑:

1. **账户级 total 漏账**:`wallet-balance` 顶层的 `totalWalletBalance` / `totalMarginBalance` **只算保证金可抵押、未锁定的部分**——探测账户里 $81,109 的 USD1(全 `locked`)不在 total 里,顶层 total 只剩 $417(USDT),而每币 `walletBalance` 里 USD1 是 $81,191。**必须遍历 `coin[]` 用每币 `walletBalance`,不能用账户级 total。**
2. **`equity` 含合约浮盈(同 OKX #259)**:统一账户里一个币作合约保证金时,它的 `equity` = `walletBalance` + `unrealisedPnl`。用 `equity` 当持有量会把没落袋的合约浮盈算进现货。**每币持有量取 `walletBalance`(纯现金,不含 uPnL)。**

**决定:Bybit 连接器一次同步用同一把 key 并发拉三桶(统一账户 / 资金 / 赚币),按每币 `walletBalance` 口径合并成一份余额;沿用 OKX 的骨架与 [ADR 0030](0030-cex-multi-wallet-best-effort-sync.md) 的尽力而为。** 具体:

- **统一账户(trading)口径** —— `GET /v5/account/wallet-balance?accountType=UNIFIED`。遍历 `coin[]`,每币持有量取 **`walletBalance`**(不含 uPnL),**估值直接用 Bybit 自带的每币 `usdValue`**(零额外请求,比 OKX 还省——OKX 要 `eqUsd/eq` 折算)。`usdValue=0` 或无价的小币交 oracle 兜底。`locked>0` 的币额外挂 balance 级 **Locked note**(探测里 USD1 全额锁定)。
- **资金账户(funding)** —— `GET /v5/asset/transfer/query-account-coins-balance?accountType=FUND`(注意:`wallet-balance` 端点**只支持 UNIFIED**,资金账户走 asset API)。每币持有量取 `walletBalance`,算 `spot`、标 `note.group:"funding"`,直接并进代币 Tab 跟同币合并。funding **无自带 USD** → 复用统一账户的 `usdValue` 当**价格提示表**(同 OKX 的 price hint),无价交 oracle。
- **赚币(earn)** —— `GET /v5/earn/position?category=FlexibleSaving`(活期)+ `category=OnChain`(链上)。每币取 `amount`(总本金)算 `spot`、进净值,标 `Earn · X% APY` balance 级 note + `note.group:"earn"`。APY 走产品端点 `/v5/earn/product` 或 position 自带字段。**Bybit 的其它 Earn 子类(定期 / Dual Asset / Launchpool / 流动性挖矿等)若无 position 读端点,不硬猜**——用户暂无这类持仓(探测 earn 仅 $91),真有再补;缺口无干净锚可对(见下)。
- **合约(perp)—— 缓做 + 兜底(同 OKX ADR 0031)** —— Bybit 的合约浮盈已在统一账户里(`walletBalance` 已剔除),`GET /v5/position/list?category=linear|inverse` 给每笔持仓的 `unrealisedPnl`。探测账户**无持仓**(`totalPerpUPL:0`、list 空),无真数据可验 → `perp_position` **留后续独立片**(有真持仓再做、拿真数据验证,不盲写)。**兜底**:检测到 positions 非空即挂账户级 Note 提示"检测到合约持仓,浮盈暂未纳入"。注意:与 OKX 不同,Bybit UTA **不产独立的 `perp_equity` 行**——权益就是统一账户本身,已由现货行承载。
- **provider 结构 + 尽力而为** —— 单 `bybitProvider`,`fetchBalances` 内部并发三桶合并成一份余额(registry「一 connector 选一 provider」不动)。逐端点 try/catch,失败不阻断其余、收进**账户级 Note**(复用 ADR 0030;Bybit 错误走 HTTP 200 + `retCode` 判定,auth 类 code → "权限不足",其余 → "暂时失败")。整次同步整体成功。
- **签名(与 OKX / binance 都不同,须新签名器)** —— `X-BAPI-SIGN = hex(HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString))`。头:`X-BAPI-API-KEY` / `X-BAPI-TIMESTAMP`(ms)/ `X-BAPI-SIGN` / `X-BAPI-RECV-WINDOW`(常量 `5000`)/ `X-BAPI-SIGN-TYPE: 2`。base `https://api.bybit.com`。GET 的被签串里 `queryString` 必须与实际发送的一字不差(同一处拼、两边共用)。对比:OKX 是 base64、prehash 含 `method+path`;binance 是 query+signature 附在 URL。故 Bybit 需要一个**独立签名器**,但仍走 `@folio/shared` 的 `createHttpClient` 壳。
- **账户级 creds(AC)** —— `apiKey`(semi)+ `secret`(secret)。**无 passphrase**(异于 OKX)。base URL 覆盖(#264)同 OKX/binance:PC 声明 `BYBIT_API_BASE` 供远程代理注入。

## Consequences

- **无 OKX 那种 asset-valuation 四桶权威锚**。Bybit 的 `wallet-balance` 顶层 `totalEquity` 只是**统一账户**的权威总额(可用来对账:Σ(统一账户每币 usdValue) 应对上 `totalEquity`),但资金 / 赚币**各自没有独立的 USD 锚**。因此 OKX 那套「earn 桶残差 → 未细分聚合行」在 Bybit **不直接适用**:靠尽量拉全已知 earn 子类,拉不到的子类只能漏(或后续找端点),没有一个"总额"能反推出未细分额。这是 Bybit 与 OKX 的实质差异,别硬套四桶对账。
- **合约权益不单列**:Bybit UTA 把合约权益并进统一账户,故本连接器**不产 `perp_equity`**——现货行即承载了权益;只在 perp 片落地时产 `perp_position`(value 0、名义/浮盈进 meta,不双算)。跨所口径上,Bybit 的合约浮盈与 OKX/binance 一样最终走「永续」,`walletBalance` 口径保证它不混进现货。
- **这轮 schema 保持 `Spot`**,不升判别联合;perp 片落地时再改 `Spot | PerpPosition`(Bybit 无独立 equity 行,故不含 `PerpEquity`)。
- **非标资产(USD1 / WLFI 等)**:探测账户大头是 USD1(World Liberty Financial USD,≈$1 稳定币,全额 locked)和资金账户里的 WLFI。Bybit 自带 `usdValue` 已能估值统一账户里的它们;funding 里的 WLFI 无自带价 → 交提示表 / oracle。稳定币兜底清单(oracle 尚未回填时按 $1)需含 USD1 之类的新稳定币。
- **`locked` 语义**:Bybit 每币 `locked` 是被订单 / 产品锁定的量(含之在 `walletBalance` 里),同 OKX `frozenBal` / binance `locked` —— 计入持有、额外挂 Locked note,不当异常。
- **待实现时对 fixture 最终核实的字段语义**:`walletBalance` vs `equity` vs `usdValue`、earn `amount` vs `effectiveAmount`(本金口径)、earn APY 字段来源(position 自带还是查 product)、funding `walletBalance` vs `transferBalance`。

关联:首个接入无独立 epic issue(待 to-tickets 拆片时开);模式先例 [ADR 0031](0031-okx-unified-account-four-bucket-cashbal.md)(OKX 统一账户,同构)、[ADR 0030](0030-cex-multi-wallet-best-effort-sync.md)(CEX 多钱包尽力而为 + 账户级 Note);口径 bug 先例 #259(统一账户 equity 含 uPnL)。
