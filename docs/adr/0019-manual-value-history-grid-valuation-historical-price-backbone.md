# manual 价值历史:时间网格估值 + 历史价预言机为骨架

Status: accepted — 修订 [ADR 0018](0018-manual-value-history-ledger-truth-no-snapshot.md) 的 **price@T 段**:把「② 账本记账价为主、oracle 历史价待 #148 升级」倒过来 —— **oracle 历史价为主路径,账本价退成兜底**;并把估值采样轴从「交易时刻」改为「区间驱动的价格网格」。**保留** 0018 其余全部决策:manual 退出 snapshot、compute-on-read、账本为真、回溯编辑整体重算、方案 A(不物化)vs 方案 B(物化留待热点)、当下值经 injector 现造盯市。

## 背景

0018 定下 manual 价值历史由账本 compute-on-read:`value@T = quantity@T × price@T`。T5(#157)落地了这套,但 `price@T` 走的是「账本里 occurredAt ≤ T 最近一条记了 price 的活动 → unitPrice 摊平」,且**曲线只在「有活动发生的时刻」采样**(外加一个当下实时点)。

这暴露一个本质缺陷:**加密组合的净值曲线,形状主要来自价格波动,不是来自用户的交易。** 用「交易时刻」当采样轴,等于用交易日志的疏密决定曲线密度 —— 一年只买过一次的 token,曲线上就只有一个点,中间一整年的市价涨跌全部缺席;而账本记账价既非市值、也不随时间变,画出来是死的。

拆解:`value(t) = quantity(t) × price(t)`,两项性质完全不同 ——
- `quantity(t)`:阶梯函数,账本 as-of 折叠唯一决定,**精确、廉价、已实现(T5),保留**。
- `price(t)`:对有市场的资产是一条**连续市场价格曲线** —— 这才是决定曲线形状的东西。

主流组合追踪器(Ghostfolio / Rotki 一类)的通行做法是**时间网格估值**:为每个资产取历史价格序列落在规则网格上(日级为主),数量投影上去逐点相乘。x 轴由**价格网格**驱动,交易只改变数量台阶。这样一年一次交易也能画出跟随市价的完整曲线。据此把 #148(历史价预言机)从「质量升级」提到**骨架**位置。

## 决策

1. **价格网格为估值主轴,交易只改数量台阶。** manual 账户价值序列在**区间驱动的规则网格**上采样(日级为主;≤90d 用小时级,与 CoinGecko `market_chart/range` 免费层自动粒度对齐),而非在交易 `occurredAt` 上采样。网格覆盖 `[max(since, 首活动), now]`,再复用现有 `downsampleSeries` 压到展示点数。

2. **网格估值只用于 manual,synced 账户保持快照。** 同步账户的历史是不可变快照,含无法历史定价的成分(质押、perp PnL、缺 identifier 的币、自填价);对其 retro-valuation 会错且贵。故只有 manual(无 snapshot)走网格。组合净值仍是「manual 网格序列 + synced 快照序列」一起喂现有 `buildPortfolioHistory`,无需特殊合并;单账户抽屉按类型分流(manual→网格,synced→快照)。两个消费点共用同一个 manual 网格 builder。

3. **历史价预言机(#148)= 骨架。** 在保留的估值门面(ADR 0013 决策 #2 / ADR 0014 单源)下新增 oracle 能力 `priceSeries(ref, from, to)` / `priceAt(ref, atMs)`,底层 CoinGecko `market_chart/range`(一 coin 一区间**一次**调用)。数据源单一 CoinGecko(与 ADR 0014 一致)。

4. **历史价按 (source, cgkId, 日期桶) 永久缓存。** 过去某天的历史价不可变 → D1 新表 `token_price_history` 永久缓存(复用 cache-util 那套 D1 参考缓存原语);**今日桶可变** → 短 TTL 或直接用现价。账本折叠廉价、每次编辑即失效 → **不缓存**;成品曲线 **compute-on-read、不物化**(方案 B 物化仍留待 profiling 证明热点,承 0018)。

5. **price@T 降级链倒序重定位(账本价不删,归位)。**
   - ① 有 identifier 且落在可取历史窗口内 → **oracle 历史价**(市值,主路径)。
   - ② 窗口外 / 取价失败 → 账本 `occurredAt ≤ T` 最近成交价 as-of(T5 现有逻辑,兜底)。
   - ③ 无 market identifier 的自定义资产 → 记录 `unitPrice` 平推(真无市场,平线才对)。
   成交价从「price@T 主来源」退成「兜底 + P&L 成本原料」—— **市值与成本基分家**,净值曲线是市值,成交价喂日后的盈亏片。

## Considered Options

- **保持 T5 的「交易时刻采样 + 账本价」(什么都不改)** —— 无外部依赖、最省,但曲线形状恒缺席市价波动,与「组合是净值追踪器」的目标相悖。被否;这正是本 ADR 要修的。
- **synced 账户也改网格估值(全量 retro-valuation,统一两条路径)** —— 表面「统一」,实则要为质押/perp/自填价/缺 identifier 的成分重造历史价(多数取不到),既错又贵,还丢掉快照这一「当时确凿值」的事实源。被否:synced 快照是源真相,不动。
- **历史价用 `/coins/{id}/history?date=`(一天一次调用)** —— 每 coin 每天一次 HTTP,区间一拉就是几十上百次。被否;选 `market_chart/range`(一 coin 一区间一次)。
- **成品曲线物化(方案 B,承 0018)** —— 提前吃物化成本 + 写路径复杂。仍推迟到 profiling 证明组装是热点再上。

## Consequences

- **依赖 CoinGecko 免费/demo 层历史窗口(最脆弱假设)。** 免费层历史数据限最近约 365 天。超窗口的 manual 曲线 → 落降级链 ②③(账本价/平推),这是 **tier 限制而非设计缺陷**;配 Pro key 解锁全历史。方案已按此变形:②③ 保留正是扛这个。**premise collapse**:若假设「免费层能给可用历史日价」不成立(某 coin 无历史、限流),该 token 该区间退化为 ②③,曲线不崩、其余 token 不受影响。

- **CoinGecko 不可用时优雅降级。** `priceSeries` 失败 → 落 ②③;已永久缓存的过去日不受影响。

- **规模。** N 个 manual token × 区间 = 首次 N 次 `market_chart/range`,之后全缓存命中(过去日永久)。self-hosted 单用户 N 小;10x 也只是首次成本。日级网格封顶点数,不爆。

- **回滚零破坏。** 纯读路径 + 加法建表(`token_price_history`),无数据迁移。回滚 = 恢复 T5 的账本采样读函数;缓存表留着无害。

- **承接 T5,不是推翻。** `quantity(t)` 折叠(`deriveAmount` / `tokenQuantityAt`)整块留用;要换的是 `buildManualAccountSeries` 的**采样轴**(活动时刻 → 区间网格)与 `tokenPriceAt` 的**主来源**(账本价 → 注入的 oracle `priceAt`)。降级链 ②③ 即 T5 现有的账本价/unitPrice 逻辑,降级保留。附带修掉 T5 遗留的「单账户抽屉 since 窗口把窗口外存量丢弃」缺口 —— 网格天然覆盖 `since→now`。

- **分片(各自独立可合并)。**
  - **Phase A — 历史价能力(#148)**:coingecko-client 加 `coinsMarketChartRange` + parse;`PriceSource` 加 `fetchPriceSeries`;`Tokens` 加 `priceSeries`/`priceAt`;D1 建 `token_price_history(source, cgk_id, day_bucket, unit_price)`(PK 三列)+ store 读写。对 fixture 测。**独立可用**:能力就位(亦可喂成交价 autofill / 日后 P&L),不改任何现有曲线行为。
  - **Phase B — manual 网格估值**:`buildManualAccountSeries` 改区间网格采样,经注入的 `priceAt` 走 Phase A;`getAccountValueHistory`(manual 分支)与 `getPortfolioHistory`(manual rows)共用;②③ 保留。**独立可用**:交付可见的正确曲线。

- **无新凭据。** `COINGECKO_API_KEY` 已在 env(可选);免费/demo 层够跑基础,Pro key 仅解锁 >365d 历史,非必需。

## 待实现时确认(不阻塞本决策)

- CoinGecko 免费/demo 层历史窗口的确切天数与自动粒度分档,Phase A 实现时以一次真实调用为准;超窗口有 ②③ 兜底。
