# 法币历史价 = 日汇率:存进 token_daily_prices、从 BTC 反算、按 fiat ref 对称读

Status: accepted。扩展 [ADR 0025](0025-fiat-holdings.md)(法币身份 + 当下 FX 估值)、[ADR 0019](0019-manual-value-history-grid-valuation-historical-price-backbone.md)(历史日价骨架)、[ADR 0006](0006-multi-currency-display.md)(多币种展示 FX)。见 [#274](https://github.com/x0finch/folio2/issues/274)。

manual 账户的价值历史曲线对**非美元法币**不准:法币没有上游币价、`recognized = false`,历史点退回账本**冻结的入账价**,只有末点(当下)走实时 FX([ADR 0025](0025-fiat-holdings.md))—— 于是非美元法币画成「一路冻结价 → 末点跳到现价」。要让历史各点也按**当时**汇率折算,需要历史日汇率。

决定:把法币的历史日汇率**当作它的「日价」存进现有 `token_daily_prices`**(行 `tokenRef = fiat/issued:<CODE>`、`unitPrice = usd_per_unit`);数值用 CoinGecko `market_chart/range` **从比特币反算**(`该币的美元价 = BTC 美元价 ÷ BTC 该币价`,与当下 `/exchange_rates` 同一套 BTC 派生);读端**对称地按 fiat ref 直接读同一张表**(不复用 `priceSeries` 的 tokenId→coingecko-ref 间接、不动「ref 空 = 未认出」约定),`buildHistoricalPriceAt` 加法币分支;取数照 `priceSeries`(按需 + 过去日永久缓存 + 今日现价 + 上游挂了降级不报错),不加 cron。

## Considered Options

- **新表 `fx_daily_rates(code, day_bucket, usd_per_unit)`** —— 语义分明(汇率 ≠ 代币价)。否:法币的「日价」本就是它的日汇率,`token_daily_prices(tokenRef, day_bucket, unit_price)` 正好装得下(unit_price 恒是美元价),复用一张全局表 + 一套读写、不新增表。
- **让法币变 `recognized`(`info.ref` 回退 fiat ref)、复用 `priceSeries`** —— 读端几乎零改。否:`info.ref` 非空会牵动全仓多处「ref 空 = 法币/孤儿」的判断(`refreshStaleInfo` / `priceOf` / 当下 FX 识别…),blast radius 大;而读表本可**对称地按 fiat ref 直读**,无需借道那个 tokenId→coingecko-ref 的函数。写、读因此保持对称 —— 写按 fiat ref 写,读按 fiat ref 读,不存在「写共用、读却要冒充」的不对称。
- **专门的法币汇率 API**(ECB / Frankfurter / exchangerate.host)—— 更干净的官方汇率。否:新供应商、要过四闸(原则 #9),且与当下的 BTC 派生**口径不一致**(历史/当下会在源上分叉、首尾对不上)。BTC 反算复用现成上游、与当下同源。
- **每晚 cron 预热** —— 曲线秒开。否:多一个后台任务,且绝大多数时候在白拉(没人看那段历史也拉);按需 + 永久缓存足够。
- **先上「整条用现价」过渡** —— 首尾一致、末点不跳。否:历史段仍不准(假装当前汇率一直成立),多改一处多上一次;法币历史是新能力、没人依赖旧行为,直接做对。

## Consequences

- **BTC 美元腿多半命中缓存**:`token_daily_prices` 的 `coingecko/bitcoin` 行本就是 BTC 每日美元价(全局表)→ 反算的美元腿读它、缺日才拉(顺带暖了 BTC 持有者的历史);真正新出网只 `BTC/该法币` 那一腿。补一种非美元法币一整段 ≈ **一次网络**。
- **只对持有的非美元法币做**;USD 恒 1(不存、不拉、不反算)。
- **BTC 反算带噪声**(加密市场的价差/流动性)——但当下 FX 已是同样的 BTC 派生,历史/当下**口径一致**,不会因源不同在首尾跳。
- `buildHistoricalPriceAt` 多一条法币分支:`fiatCodeOf` 命中的 token 走新的 fx-history 读法(按 fiat ref 读 `token_daily_prices` + 冷则派生),不走 `priceSeries`;「ref 空 = 未认出」约定不动。
- `token_daily_prices` 从此混装两类行:加密币价(`coingecko/<id>`)与法币日汇率(`fiat/issued:<CODE>`)—— 都是「某 tokenRef 某日 = 多少美元」,同构;仍是原则 #6 的受控例外(无用户数据、可整表重建)。
