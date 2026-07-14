# 稳定币经 CoinGecko 分类判定(`is_stablecoin` facet)

Folio v2 的组合分析需要「稳定币」口径 —— Insights `type` 维的 Stablecoin 桶 + 主页 hero 的稳定币占比指标 —— 而当前代码**无任何稳定币分类**(原型里 `stable:true` 是硬编码)。决定用 CoinGecko **批量分类端点** `/coins/markets?category=stablecoins`(一次分页拉全量稳定币 coin id 集)回填到 `tokens` 新增的 `is_stablecoin` facet(随 info 长 TTL 刷新),**不**逐币查 `/coins/{id}` categories(省 CGK 额度)。

## Considered Options

- **手工维护 `STABLE_SYMBOLS` 常量集** —— 轻,但需人肉维护、易漏新币、按 symbol 判易误伤同名币。
- **逐币 `/coins/{id}` categories** —— 最准,但每币一发、极耗 CGK 额度,不可行。

## Consequences

- 需 schema 迁移(`tokens` 加 `is_stablecoin` 列)+ 扩 oracle 抓取契约(info facet 多一次批量分类拉取)。
- **孤儿 token(CEX / manual / CGK 未收录)无 CGK 分类 → 一律当非稳定币**,这是本路线的固有盲区。
- `type` 维**「kind 先行」**:DeFi / Perp 头寸里的稳定币按 `kind` 归 DeFi / Perp,只有 `spot` 内的稳定币才进 Stablecoin 桶(避免同一笔双计)。
