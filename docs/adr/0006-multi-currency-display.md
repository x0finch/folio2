# 多币种展示:USD 基准 + 展示层换算 + CoinGecko exchange_rates

Status: accepted

全站以 **USD 为唯一计价基准**存储/聚合(provider 权威),多币种只是**展示层的一次换算**:展示值 `= usdValue / rate`,`rate = usd_per_unit`(1 单位展示币种的美元价)。汇率取自 CoinGecko **`/exchange_rates`**(以 BTC 为基准单位一次拿全,`rate = rates.usd.value / rates.<c>.value`,BTC 约掉)。偏好币种按浏览器存于 **cookie `folio_currency`**(仿 locale),非账户级。FX 逻辑做成独立包 **`@folio/fx`**(镜像 `@folio/platforms`),缓存落 `@folio/db` 的 `fx_rates` 表。

## Considered Options

1. **按目标币种直接查价**(`vs_currency=eur`)—— 要把 USD 基准贯穿存储/聚合/provider,侵入整条管线;放弃。
2. **专用 FX API / ECB 等**—— 多一个数据源 + apiKey + 失败面;CoinGecko 已在用且 `/exchange_rates` 够用。
3. **展示层换算 + CoinGecko exchange_rates(选中)**—— 存储恒 USD,只在渲染时换算一次;复用既有 client、零新数据源。

## Consequences

- **历史净值图用当前汇率整体换算**(不存历史汇率):图形按当前 rate 缩放,语义="此刻若换成 X 值多少"。刻意不做逐日历史 FX(范围差一个数量级)。
- **FX 缓存软过期**:`resolve` 总返回最近一次汇率,`expires_at` 只闸 `warm`(搭 sync 刷新,TTL ~6h);冷缓存时 `_authed` loader **按需 warm 一次**(exchange_rates 一次拉全),首次切换即生效、不必先 sync;仅拉取失败/离线才回退 USD。**与 `platforms` 的硬过期 + 否定缓存不同**——展示汇率宁可旧、不可掉回 USD。
- **两条格式化路径**:法币走 `Intl.NumberFormat(style:"currency")`(符号/位置/小数位随币种与 locale,USD 由此从 `$5` 变 `$5.00`);**加密(BTC/ETH)不是 ISO 4217,Intl currency 会抛错** → 走 `₿`/`Ξ` 前缀 + 高精度数字(复用 `formatNumber`)。极小值两路都用下标记法。
- 支持币种 = ~10 主流法币 + BTC/ETH,每项带 `kind: fiat | crypto`;cookie 值按此校验。
- 换算只作用于**最终展示的 USD 值**(不逐 source 换算);代币**数量**不换算(数量 vs 货币两套格式化)。
- 新增包 `@folio/fx` + `fx_rates` 表(drizzle 迁移);rate 经 `_authed` loader → `CurrencyProvider` context 下发(仿 `__root` 下发 locale)。
