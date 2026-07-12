# `@folio/oracle`:合并参考层三包 + 币级身份去 vendor tag + 可切换多价格源

Status: accepted — 激活并扩展 [issue #46](https://github.com/x0finch/folio2/issues/46)(代币源 vendor 中立)。合并 [ADR 0005](0005-shared-coingecko-client-and-platforms-package.md)(独立 `@folio/platforms`)与 [ADR 0006](0006-multi-currency-display.md)(独立 `@folio/fx`)的**打包边界**——两者的领域决策(平台元数据缓存、存 USD/展示层换算)不变,只是合入统一门面。聚合原则([ADR 0001](0001-aggregate-by-token-group.md) 按 TokenGroup、[ADR 0002](0002-never-merge-by-symbol.md) 永不按 symbol 归并)不变,归并键改由内部 id 承载。经 `grill-with-docs` 定案(决策记录见 `.scratch/plans/oracle-grill-decisions.md`,一次性)。

## 背景

参考层有三个「CoinGecko 支撑的全局缓存」——`@folio/platforms`(链/场馆 name+logo)、`@folio/fx`(展示币种 + USD 汇率)、`@folio/tokens`(代币身份+价+logo)——结构几乎同构(source 取数 + store D1 缓存 + service resolve/warm),却各自把 CoinGecko 写死或半写死。

要支持**用户随意切换价格源**(CoinGecko / CoinMarketCap / DefiLlama),两处挡路:

1. **身份带 vendor tag**:`TokenRef = {source:"coingecko"; identifier}`、`refKey = "coingecko:<id>"` 是聚合/TokenGroup 的**分组身份**,还被 manual 选币写进 balance、落进快照。跨链同币(USDC 在 arb/eth)现在正是靠同一个 `refKey=coingecko:usd-coin` 归并。换源 → 同一币旧 `coingecko:x` ≠ 新 `cmc:y` → 不归并、历史快照对不上。
2. **打包分散**:三包各绑 CoinGecko、各一套 source/store/service,无统一「行情厂商」抽象。

同时要:从 balance provider 拿到的持仓**自带价**,源没价时用自带价补(第 2 诉求);一个全局开关可强制**一律用源价并重算 value**(第 3 诉求)。

**关键事实(缩小实现量)**:`tokens` 表已有 `id: UUID PK`(vendor 中立),跨链同币经 `linkTokenKeyToCgk` 本就归并进同一行。内部中立身份**已存在**,无需发明。

## 决策

1. **合三包为 `@folio/oracle`**(子包 `oracle-basic` 契约 / `oracle-entry` 门面 `createOracle` / `oracle-providers/coingecko`),统一 **vendor 抽象**:每 vendor 声明 `capabilities`(prices / tokenMeta / platformMeta / fxRates);取数入口按**活跃源**路由,活跃源缺某能力 → **回退 baseline(CoinGecko 永在册)**。DefiLlama 只有价、无法币 FX/logo,靠此回退存活;UX 仍是一个源下拉。D1 schema 仍归 `@folio/db`(不搬表)。

2. **币级归并身份去 vendor tag**(#46 核心):归并改按**内部 `tokens.id`**(已中立、已归并跨链同币);各家 coin id 降为映射属性,存 **`token_vendor_ids(tokenId, vendor, vendorId)` 子表**(一行一映射,接新源只加行不改表结构);`tokens` 表**移除 `source`/`identifier` 列**,孤儿行 = 无 vendor 子表行。`TokenRef{source,identifier}` 作废,身份 = 内部 id 引用。balance/快照里的 `coingecko:` tokenKey **不迁移**(经 tokenIndex 仍解析到同一 id);manual 选币不变。

3. **纯 vendor 币接受碎裂**:无链上合约、只靠某家 coin id 存在的币(主要是纯手动选的 CGK 币)换源后**回退自带价/冻结值,不从新源取价**;迁移脚本 log 其数量。**不做 symbol 模糊对映**(误判比碎裂更危险)。同时也在链上持有的币靠合约 tokenKey 自动重认,不碎。

4. **估值优先级 = 一个纯函数,两处调用**:`valuate(amount, providerPrice, sourcePrice, mode)`(放 `oracle-basic`,纯、可测)——`provider-first`(默认)有自带价用自带、无则源价补、都无保留;`source-first`(开关开启)有源价用源、无则回退自带。`providerPrice = balance.price ?? value/amount`。
   - **写路径**(sync 的 `revalue`):按当前 mode 算 value 写快照,并存 **`snapshot_balances.provider_price`**(冻结)。泛化今天写死的 `REVALUE_TYPES`。
   - **读路径**(总览 `overview`):按当前 mode 用「存的 provider 单价 + 实时源价」**现推当前 value** → 按开关即时重算、无需重新 sync;**历史曲线用快照冻结 value 不重算**。`aggregate` 不改。
   - mode + 活跃源存 **per-user D1 `user_settings`**(非 cookie,因需影响 cron sync)。

5. **三阶段 expand → contract**(改的是持久化身份,风险与引入解耦):
   - **Phase 1**:合包 + 身份重构一次做完整(建 `token_vendor_ids` + 回填 + 移列 + 定新身份类型),仍只接 CoinGecko,行为不变;老三包留 re-export shim,import 不动。附加式迁移,非破坏性身份重写(内部 id 不变 → 归并不断、历史不裂),回滚可反填。
   - **Phase 2**:删 shim + 改 import 到 `@folio/oracle`。
   - **Phase 3**:接第二源(先 DefiLlama,零凭据)+ 估值 policy + `user_settings` + 快照 `provider_price`。

6. **全局参考缓存受控例外**(原则 #6):oracle 只存全局参考数据(价/身份/元信息/汇率),**永不碰 userId 数据**;合包后缓存面变大,边界在此显式声明。

## Considered Options

- **B:逐地址 `(chain,contract)` tokenKey 当身份 + TokenGroup 兜跨链** —— 无内部 id 概念,但跨链同币默认散开,现在靠 CGK 自动归并、没铺 TokenGroup 种子的币会**回归成不归并**。否。
- **C:保留 vendor-tagged ref,换源时维护翻译表** —— 改动最小,但治标:接第三家又要补一张表,映射缺失就碎。否。
- **vendorIds 加列(coingecko_id/cmc_id/…)而非子表** —— 简单,但接新源要改表结构。否(子表可无限扩展)。
- **每类数据独立选源(四个下拉)** —— 最灵活但设置复杂、组合爆炸。否(整 vendor 一起切 + 能力回退)。
- **估值 policy 按 connector 分档** —— 更精细但超出诉求。否(全局单开关)。
- **历史快照随开关回溯重算** —— 语义最彻底但需历史各币各时点的源价(源未必提供)、风险高。否(历史冻结,只现推当前视图)。
- **symbol 模糊对映救纯 vendor 币** —— symbol 易撞、静默认错币比碎裂更危险。否(接受碎裂)。

## Consequences

- **删包**:`@folio/platforms`、`@folio/fx`(Phase 2)。
- **契约**:`TokenRef{source,identifier}` 作废 → 内部 id 引用;新增 `valuate()` + vendor 抽象(capabilities)于 `oracle-basic`。
- **db**:新表 `token_vendor_ids` + `tokens` 移除 `source/identifier`(Phase 1 附加迁移);`user_settings`(activeVendor/valuationMode)+ `snapshot_balances.provider_price`(Phase 3)。`coingecko:` tokenKey 不迁移,原「破坏性身份迁移」取消。
- **app**:`revalue`(泛化按 mode)、`overview`(读路径现推)、设置页(源下拉 + 估值开关);`aggregate`、历史图读路径不改。
- **凭据**:Phase 1/2 无新凭据;Phase 3 DefiLlama 无 key,CMC 需 `COINMARKETCAP_API_KEY`(CF Secret)。
- **CONTEXT.md 词表**:参考层身份术语(refKey/TokenRef → 内部 id + vendorIds)、oracle 门面、估值 policy 待随实现更新。
- **延后 unknown**(不阻塞 Phase 1/2):第二源选 DefiLlama 还是 CMC;`user_settings` 独立表 vs 挂 user 行。
