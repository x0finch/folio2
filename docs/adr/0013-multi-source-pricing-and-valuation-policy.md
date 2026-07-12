# 多源定价 + 估值优先级 policy(oracle Phase 3 运行时行为)

Status: accepted — 在 [ADR 0012](0012-oracle-merge-vendor-neutral-identity-multi-source.md) 的身份/打包地基之上,固化多源定价的**运行时行为**(0012 决策 #4 的落地)。经 `grill-with-docs` 定案(决策记录 `.scratch/plans/oracle-phase3-grill-decisions.md`,一次性)。Phase 1(#71/#72/#73)已合:oracle 合包 + 内部-id 归并身份 + `token_vendor_ids`。

## 背景

Phase 1 让币的归并身份 vendor 中立(内部 `tokens.id`),各家 coin id 存 `token_vendor_ids` 映射。但仍只有 CoinGecko 一家、无切换、无估值策略。本阶段实现用户最初的三诉求:① 随意切换价格源;② 源没价用 balance provider 自带价补;③ 一个全局开关强制一律用源价并即时重算。

## 决策

1. **第二个源 = DefiLlama**(CMC 作后续)。免费、零凭据;其价格 API 按「链:合约地址」寻址,与我们的中立自然键(tokenKey)对齐 → 链上币换源靠合约**自动重锚**、不碎;验多源 seam 成本最低。DefiLlama 只供价 → 缺的能力回退 baseline。

2. **对外统一门面、对内三独立服务**。`createOracle` 返回一个 `Oracle`(`{ priceOf / resolveToken / resolvePlatform / fxRate / warm / … }`),app 只认它一个入口;**内部仍组合 tokens / platforms / fx 三个各自内聚的服务**,门面只做组合 + 活跃源路由,不拆内部实现。app 的 server/{tokens,platforms,fx} 三处装配收敛为一处。

3. **capability 路由 + baseline 回退**。门面每方法按 `activeVendor` 选 provider;活跃源不供该 capability(prices/tokenMeta/platformMeta/fxRates)则回退 baseline(CoinGecko 永在册)。选 DefiLlama 时:价走 DefiLlama,元信息/平台/FX 回退 CGK。用户只见一个源下拉,回退是内部规则。

4. **估值 = 一个纯函数 `valuate(amount, providerPrice, sourcePrice, mode)`**(Phase 1 已在 `oracle-basic` 备好位)。`provider-first`(默认)有自带价用自带、无则源价补、都无保留;`source-first`(开关)有源价用源、无则回退自带。

5. **存原料、不只存成品**。每笔持仓 `snapshot_balances` 存 `amount` + `usd_value`(成品,冻结,历史曲线用)+ **新增 `provider_price`**(自带单价,原料,冻结)。**当前视图不读 `usd_value`,从原料 + 实时源价 + 当前 mode 现推**。值按「快照 × 持仓」存、与 token 内部 id 无关。

6. **切开关/换源即时生效、无需重 sync**;历史冻结。当前总览按现行 mode 现推;历史快照的 `usd_value` 不动。

7. **图表「当下点」实时算,历史点冻结**。图表最右点用与主页同款的实时总价(消除「切开关后主页 vs 曲线右端」的临时误差),更早的点用冻结 `usd_value`。语义:过去照记录、现在随当前设置走;主页总价 ≡ 曲线当下点。

8. **per-user 设置 = 独立表 `user_settings(user_id PK, active_vendor, valuation_mode)`**。必须影响后台 cron sync 的 revalue → 不能用 cookie(与展示币种偏好不同)。独立表(非挂 better-auth 的 user 表)可扩展、不与 auth schema 纠缠。

9. **换源冷启动 = 懒填 + 空窗回退**。切源后新源映射不预造;首次 sync 用持仓的中立 tokenKey(链:合约 / native)去新源 resolve → 命中同一内部 id → 挂新源的 `token_vendor_ids` 映射(`linkTokenKeyToCgk` 泛化到任意 vendor)。映射/价未填的空窗期,估值回退自带价。

10. **换源可逆、自带价不丢**。自带价(账户侧,与市场源无关)与源价(市场源)并存;换源只换源价,从不覆盖自带价;原料(amount + provider_price)恒存 → 任何 mode/源当场可重算回来。**D2 残留**:无自然键币(纯 symbol / 纯 vendor)身份在两源间振荡(换回确定性回到原内部 id,不丢值;历史曲线切换边界该币有断点),= 已接受边界。

## Considered Options

- **CMC 先接** —— 覆盖广但需付费 key、自家数字 id、合约查询靠高级层,重锚不如 DefiLlama 直接。否(作后续)。
- **对外也保持三服务 / 彻底揉成一坨** —— 前者 app 仍三处装配;后者拆掉内聚实现。选「对外统一、对内三块」中间态。
- **切开关下次 sync 才生效 / 切开关写新快照** —— 前者有延迟感;后者每切污染历史加点。选「读时现推、历史冻结」。
- **图表最新点也用冻结值** —— 与主页实时总价对不上(临时误差)。选「当下点实时算」。
- **设置挂 better-auth user 表** —— 与 auth schema/迁移纠缠。选独立表。
- **symbol 模糊对映救无自然键币换源** —— 误判比碎裂危险。否(接受 D2 碎裂)。

## Consequences

- **schema**(`@folio/db`):新表 `user_settings`;`snapshot_balances` 新增 `provider_price` 列。
- **契约/门面**:`createOracle` 返回统一 `Oracle`;vendor capability 路由 + baseline 回退;新增 `@folio/oracle-provider-defillama`。
- **估值**:`revalue` 泛化按 mode 写 `usd_value` + 存 `provider_price`;overview 读路径现推;图表读路径当下点用实时总价。`valuate()` 落地(Phase 1 已备位)。
- **app**:三处装配收敛为 `createOracle`;设置页加「源下拉 + 估值模式开关」(控件用现有 `@folio/ui`,不碰原则 #11)。
- **凭据**:DefiLlama 无 key;CMC(后续)需 `COINMARKETCAP_API_KEY`(CF Secret)。
- **不做**:CMC provider(后续);历史回溯重算;symbol 模糊对映。
- **CONTEXT.md 词表**:activeVendor / valuationMode / provider_price / 成品-vs-原料 待实现后更新。
