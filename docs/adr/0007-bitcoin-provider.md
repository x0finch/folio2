# Bitcoin provider — 本地派生 + 用户选脚本类型 + 已确认权威

Status: accepted (planned — M9.1)

新增只读 Bitcoin provider(`accountType: onchain_bitcoin`,已预留):单 `identifier` 输入收**地址或扩展公钥**(xpub/ypub/zpub),模式自动判别。xpub 用 **`@scure/btc-signer`** 本地派生(隐私:API 不见 xpub),**脚本类型由用户在 add-account 选**(`BitcoinFields` 定制分支,按前缀预选:xpub→Native SegWit、ypub→Nested、zpub→Native,四种含 **Taproot** 可选、可改),选定 → **单脚本** gap 扫描。数据源 **mempool.space**(免密钥;`BITCOIN_ESPLORA_BASE` env 可覆写为自托管 Esplora)。**已确认余额进权威总额,未确认(mempool)经 `BitcoinMeta` 单列**;xpub 下额外产派生地址 BTC 分布(仅非零)+ 收款地址指引(上次用过 + 下两个未用外部地址)。

## Considered Options

1. **第三方 xpub API**(blockchain.info `/multiaddr` / blockchair `/dashboards/xpub` 服务端派生)—— 一次调用、免派生库,但依赖易变端点、信任其枚举你的地址、脚本类型覆盖受限(blockchain.info 仅 legacy xpub)。
2. **自动多脚本扫描裸 xpub**(p2pkh+p2wpkh+p2tr 取有历史者)—— 免用户选,但 ×3 子请求易撞 CF Workers 上限,且可能"猜错→余额 0"。
3. **本地派生 + 用户选脚本类型(选中)** —— 消歧义、单脚本省子请求、taproot 一等公民、隐私(公共 API 只见派生地址、不见 xpub)。

## Consequences

- **值不在 provider 算**:provider 只给 amount(confirmed BTC),`value` 交给推广后的 `revalue`(`manual` + `onchain_bitcoin` 盯市,`amount × tokens.priceOf(BTC)`)—— token 层是唯一价源。已确认进总额;**未确认可被 RBF/丢弃,故单列不进权威值**。
- **脚本类型建模** = `public` input(enum 校验)+ add-account 的 `BitcoinFields` 定制分支(`ProviderInputType` 无 enum/select,故动态显隐 + 前缀预选走定制 UI,仿现有 manual/perp 分支)。
- **子请求上限应对**:单脚本 gap 20 扫描 + 总地址硬上限(~60)+ `truncated` 标记 + `BITCOIN_ESPLORA_BASE` 自托管(大钱包正解);逃生口=xpub 批量走 blockchain.info multiaddr。
- **零 schema 改动**:`onchain_bitcoin` 已在 `AccountType` 预留;`identifier`/`scriptType` 落现有 `creds`(public)。回滚=从 registry 移除。
- **分阶段**:阶段 1 单地址(可单独上线,无派生库);阶段 2 xpub 派生 + `BitcoinMeta`(分布 + 收款地址 + pending)。
- **BTC 定价**经 symbol 回退(BTC 在 top-markets),`tokenKey = chain:bitcoin/native:BTC` 仅作身份 + 平台归属(`chain:bitcoin` → "Bitcoin")。
