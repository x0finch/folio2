# Bitcoin provider — Blockbook 服务端派生 + 用户选脚本类型(仅裸 xpub)+ 已确认权威

Status: accepted (M9.1)

新增只读 Bitcoin provider(`accountType: onchain_bitcoin`,已预留):单 `identifier` 输入收**地址或扩展公钥**(xpub/ypub/zpub),模式自动判别。数据源 **Trezor Blockbook v2**(`/api/v2/xpub` 服务端派生,一次调用拿余额 + 逐地址;内置 `btc2–btc5` 多端点轮询 + 失败回退,无需 env)。**脚本类型**:`ypub`/`zpub` 前缀已确定(Nested / Native)→ 只读展示;**仅裸 `xpub` 歧义 → 用户在 add-account 选**(默认 Native SegWit,四种含 **Taproot** 可选)。**已确认余额进权威总额,未确认经 `BitcoinMeta` 单列**;xpub 下额外产派生地址 BTC 分布(仅非零)+ 收款地址指引(上次用过 + 下两个未用外部地址,**本地派生不出网**)。

## Considered Options

1. **本地派生 + 逐地址 gap 扫描(Esplora / mempool.space)** —— API 不见 xpub(隐私最佳),但一个 xpub 要 ~40 次串行请求,公共节点限流下**体验差**(实测慢);CF Workers 子请求上限还需 gap/cap/truncated 兜底。
2. **Blockbook 服务端派生(选中)** —— `/api/v2/xpub` 一次返回汇总余额 + 逐地址,快;代价是 xpub 交第三方(Trezor)派生。缓解:Blockbook 开源可自托管;**收款地址指引仍本地派生**;多端点轮询抗限流。
3. **自动多脚本扫描裸 xpub** —— 免用户选,但多脚本 ×N 请求更重,且可能"猜错→余额 0"。

**取舍**:选 2。M9.1 初版曾按 1 落地(见下 Revision),但逐地址 gap 扫描的公共节点体验不可接受 → 改用 Blockbook 换取一次调用的响应。隐私由"可自托管 + 收款地址本地派生"缓解。

## Consequences

- **值不在 provider 算**:provider 只给 amount(confirmed BTC,取 Blockbook 顶层已汇总 `balance`),`value` 交推广后的 `revalue`(`manual` + `onchain_bitcoin` 盯市,`amount × tokens.priceOf(BTC)`)。已确认进总额;**未确认可被 RBF/丢弃,故经 `BitcoinMeta.pendingSats` 单列、不进权威值**。
- **分包**:取数 = `@folio/blockbook-client`(SDK 式,btc2–5 轮询+回退);扩展公钥 token 造型(脚本类型→SLIP-132 前缀 / taproot descriptor)+ 收款地址本地派生 + 校验 = `@folio/bitcoin-derive`;provider 只整合。(初版的 `@folio/mempool-client` 已退场。)
- **脚本类型建模** = `public` input(enum 校验,仅裸 xpub 消费)+ add-account `BitcoinFields` 定制分支(`ProviderInputType` 无 enum:裸 xpub 给 select,ypub/zpub 只读展示识别到的类型)。zpub/ypub 前缀权威,provider 忽略传入 `scriptType`。
- **无子请求上限问题**:Blockbook 服务端做 gap 扫描,provider 不再逐地址扫,`GAP_LIMIT`/`ADDRESS_CAP`/`truncated` 随之移除。
- **无 env**:端点内置(btc2–5 轮询);不设 `BITCOIN_*_BASE`。自托管 Blockbook 若需要,后续再加配置。
- **零 schema 改动**:`onchain_bitcoin` 已在 `AccountType` 预留;`identifier`/`scriptType` 落现有 `creds`(public)。回滚=从 registry 移除。
- **BTC 定价**经 symbol 回退(BTC 在 top-markets),`tokenKey = chain:bitcoin/native:btc` 仅作身份 + 平台归属(`chain:bitcoin` → "Bitcoin")。

## Revision(2026-07)

初版按 Considered Option 1(本地派生 + Esplora 逐地址 gap 扫描)交付(commits `2b18…`/`0645…`/`ecfd…`)。实测公共 mempool.space 逐地址扫描慢且易限流 → 反转为 Option 2(Blockbook 服务端派生)。同时:脚本选择器收窄为仅裸 xpub(ypub/zpub 前缀已定,选了反而可能选错);去掉 `BITCOIN_ESPLORA_BASE` env(改内置多端点轮询);退场 `@folio/mempool-client`。本地派生库保留用于 token 造型 + 收款地址派生 + 校验。
