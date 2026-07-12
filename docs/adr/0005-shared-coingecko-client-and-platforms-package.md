# 抽出共享 CoinGecko client,新增 @folio/platforms 包

Status: accepted (implemented — platform-meta #01–#04)。**打包边界部分被取代**:见 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md)——`@folio/platforms` 合入统一门面 `@folio/oracle`;平台元数据缓存的领域决策不变。

为了给 HoldingSource 的**平台**(链 + 交易所/perp)补上 name + logo(数据源同为 CoinGecko),把 CoinGecko 的 HTTP 客户端从 `@folio/tokens-provider-coingecko` 抽成独立包 **`packages/clients/coingecko`**(`@folio/coingecko-client`),由 token provider 与新的 **`@folio/platforms`** 包共同引用;平台元数据缓存落 `@folio/db` 的新 `platforms` 表。**不**把平台元数据塞进 `TokenSource`(职责分明)。

## Considered Options

1. 扩进 `@folio/tokens`(`TokenSource` 加 `fetchChains`/`fetchVenue`)—— 最省包,但把"链/场馆"塞进"代币源",职责变味。
2. app 层独立 fetch+缓存,不复用 provider —— 会重造 CoinGecko 的 http/apiKey/错误处理(含 CF Workers 的两处修复)。
3. **抽共享 client + 独立 `@folio/platforms` 包(选中)** —— 单一职责清晰;把只在 token provider 里的 **CF Workers fetch 修复(User-Agent 头 + `fetch.bind`/错误重试)收敛到一处**,token 与 platforms 共用。

## Consequences

- 新增 2 个包(`@folio/coingecko-client`、`@folio/platforms`)+ workspace glob `packages/clients/*`;`@folio/db` 加 `platforms` 表(drizzle 0015)。
- **对正在工作的 token provider 是一次重构**:把 `HttpCtx`/`request`/base URL/`USER_AGENT`/错误映射/`parseRetryAfter` 移入 client —— token 的既有测试须全绿(回归面)。
- client 引入自有错误类型;token/platforms 各自映射成 `TokenError`/`PlatformError`(共享 client 不吐 token 域错误)。
- `@folio/platforms` 刻意**不照搬 tokens 的三层**(basic/entry/provider):平台无 top-N/懒解析复杂度,CoinGecko 是唯一源 → 一个包内含契约 + 实现 + 服务(YAGNI)。
- 平台元数据近静态:warm-on-sync 写缓存、读 cache-only、长 TTL、venue 404 负缓存(三态与 token-store 对齐)。聚合归并逻辑不变;`aggregate.ts` 仅去掉 `CHAIN_LABELS` 硬编码、`HoldingSource.platform` 加 `logo?`,name/logo 由 overview 聚合后装饰(保持 aggregate 纯函数)。
