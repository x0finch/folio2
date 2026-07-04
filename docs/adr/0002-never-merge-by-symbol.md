# 只按已验证的规范身份归并,绝不按 symbol

Symbol 严重撞名(usdc 58 个 coin、weth 62 个)。若按 symbol 合并持仓,一个山寨 "USDT" 就会把假余额混进真实总额。因此聚合用一条**四级归并键,任何一级都不含裸 symbol**:`group:<id>` → `token:<refKey>`(已解析的规范 Token)→ `<tokenKey>`(精确合约 = 已验证同一个币)→ `${accountId}:${symbol}`(未解析且无 tokenKey,不跨账户)。未解析的持仓宁可各自成行,也不按名字合并。

## Consequences

- CGK 未收录的长尾币在 3 条链上持有 = 3 行(3 个不同合约)。为诚实(不臆造总额)接受这点。
- 这是**刻意的反直觉设计**:后人若"顺手按 symbol 分组"简化,会把上述 bug 改回来 —— 勿改。
