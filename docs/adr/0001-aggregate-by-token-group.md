# 按自有 TokenGroup 聚合,不用 CoinGecko coin id

CoinGecko 故意把桥接币拆成不同 coin id(`tether` / `usdt0` / `bridged-usdt` / `usdt.e`,价格也真分叉),所以 CGK coin id **不是**跨链身份 —— 直接按它聚合永远合不出"一个 USDT"。因此总览的"按代币"聚合以**产品自有的 TokenGroup**(策展展示家族,种子 ~20 行,后续支持用户覆盖)为单位;没有分组的 Token 即自身单例组。这是实现"USDT 跨链总和"(需求 1–4)的唯一正确途径。

## Consequences

- 需维护一张种子成员表(`cgkId → group`);名单错 = 误合/漏合,故成员**执行时按 CGK 实查逐个确认**。
- 桥接币的 CGK 身份漂移(如 USDT→usdt0 重新归属合约)只影响成员映射,不影响历史快照。
