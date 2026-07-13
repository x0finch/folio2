# 废止运行时换价源(DefiLlama / activeVendor),回归 CoinGecko 单源

Status: accepted — 取代 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md) 决策 #4(可切换多价格源)与 [ADR 0013](0013-multi-source-pricing-and-valuation-policy.md) 决策 #1(DefiLlama 第二源)、#3(capability 路由 + baseline 回退)。**保留** 0012 决策 #1(合三包为 `@folio/oracle`)、#2/#3(内部-id 归并身份、`token_vendor_ids` 映射表)与 0013 决策 #2(统一门面 + 三内聚服务)、#4(`valuate` 估值 policy)、#5(存原料 + 实时重算)。

## 背景

Oracle Phase 3(#79/#82/#92)在 vendor 中立身份地基上,搭了「用户随意切换价格源」的运行时基建:第二源 DefiLlama、`activeVendor` per-user 设置、门面按活跃源路由 + 缺能力回退 baseline。但该能力实际从未接通 —— `app` 侧 oracle 门面从不向 `createOracle` 传 `activeVendor`,`pickSource` 恒解析到 CoinGecko;无 settings UI;#83(双源价格写路径)始终未竟(见 PR #94,已关闭)。

复盘结论:**CoinGecko 数据已足够全,随意切换价格源无现实必要**,徒增维护面(第二源包、vendor 路由、跨源重锚、per-vendor 存储诉求)。与其留一套休眠且未竟的基建,不如收敛回单源,把复杂度降到与实际需求相称。

## 决策

1. **删 DefiLlama 源** `@folio/oracle-source-defillama`(整包)及 `@folio/oracle` 对它的依赖。

2. **删 vendor 路由**:移除 `packages/oracle/entry/src/vendors.ts`(`VENDORS` 注册表 / `pickSource` / `BASELINE_VENDOR` / `VendorImpl`)。`createOracle` 去掉 `activeVendor` 入参,三服务(tokens/platforms/fx)直接由 CoinGecko 供源。

3. **删 per-user 换源设置**:`user_settings.active_vendor` 列移除(增量迁移 `0001`,`DROP COLUMN`);`getUserSettings`/`updateUserSettings`/`UserSettingsView` 去 `activeVendor`。**估值模式 `valuation_mode`(self-first / source-first)保留** —— 它是「自填价 vs 源价谁优先」的正交维度,与价源无关。

4. **删跨源重锚**:`token-store.ts` 的 `linkTokenKeyToCgk` 里「本源无映射但 tokenKey 已指向他源 canonical 行 → 复用同一内部 id」分支移除(单源下永不触达)。

5. **类型级 vendor tag 收敛**:`TokenRef` 判别联合去掉 `defillama` arm、删 `DefiLlamaCoinId`,回到单 `{ source: "coingecko"; identifier: CgkCoinId }`(保留判别联合形状,将来加源仍零返工)。

**保留(明确不动)**:
- **vendor 中立身份**(`tokens.id` UUID + `token_vendor_ids` 映射表):它先于换源存在(#73,跨链同币经 `linkTokenKeyToCgk` 归并进同一内部行),有独立价值(孤儿行、稳定 logo id、跨链归并),非换源残留。当前仅存 `vendor="coingecko"` 一种映射;`createTokenStore(source)` 分桶签名保留。
- **统一门面 + 三内聚服务**(0013 #2)、**`valuate` 估值 policy + self-first/source-first 开关**(0013 #4)、**存原料 + 实时重算**(0013 #5):全部照旧。

## 后果

- 代币源包收敛为 CoinGecko 一家;`@folio/oracle` 依赖面 -1。
- `token_vendor_ids` 表结构不变但事实上单值;若将来彻底单源无虞,可再评估塌回 `tokens` 的 coin id 列(本 ADR 不做,属独立决策)。
- 迁移走增量 `0001`(承接 #95 的单 baseline 之后)—— 保本地开发数据不重置;无远端库。
- 四闸全绿(typecheck / 313 包测试 / 145 web 测试 / lint 零新增 / build)。
