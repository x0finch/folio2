# Folio Roadmap — 叙事 / 范围 / 依赖

> 前向 **epic 看板 = [GitHub Project #1 "Folio Roadmap"](https://github.com/users/x0finch/projects/1)**(一里程碑一 issue、`roadmap` 标签、Tier 分层,进度事实源)。
> 本文只留看板放不下的**叙事、依赖、范围边界**;开工某条 epic 时经 `to-tickets` 拆竖切片。已交付功能的历史见 git log + [docs/adr/](adr/)。

## 现状一句话

Folio 今天是**带统一定价 + 多币种展示 + 分析拆分**的多源组合追踪器:链上 / CEX / perp / manual / **Bitcoin(地址 + xpub)** 余额 → 归一 USD → **canonical 代币聚合** → 展示(24h 涨跌 / 占比 / 单资产 drill-down / 净值曲线),可切法币或 BTC/ETH 计价。DB 现由 **per-user 代币层**(`tokens`,以 `tokens.id` 为唯一贯穿身份,vendor 叫法退到 `token_refs` 边界)、**全局公开参考层**(`global_token_ref_index` 地址→上游叫法、`token_daily_prices` 历史日价)、**per-user 缓存**(`user_cache`,吞掉旧 FX/平台表)、`manual_activity`、`snapshot_balances`(逐资产存 `amount`/`usd_value`/`self_price`,身份为必填 `token_id`)与 **`portfolios` + `portfolio_accounts`(命名账户集 + 一对一归属,ADR 0033)** 组成。

> **代币身份 epic 已完工**(#176:tokens 收归 per-user + `tokens.id` 唯一身份 → ADR 0021/0022;含导出/导入 v3 #204)。旧代币层 `token_index`/`token_meta`/`token_groups`/`platforms`/`fx_rates` 已删,业务/展示层零 vendor(CGK 只在 oracle 组合根这一处边缘)。

> **多 Portfolio epic 已完工**(#331:总览 / 账户页 / Insights 按「当前选中的 Portfolio」聚合,顶层净值 = 选中组合 Σ → ADR 0033)。「观察一个账户但不计净值」= 把它归到非默认组合的自然结果(不引入账户特殊状态)。含全局顶部选择器(≥2 才浮现、选中不持久化)、抽屉「移到组合」归属、组合 CRUD 管理(改名 / 设默认 / 删除);账户 ↔ 组合先锁一对一(`UNIQUE(account_id)`),地基已按可平滑升 M:N 铺好。旧的未用 `groups`/`account_groups` 整套已删。竖切片 #332–335 已合入。

**仍缺 Tier-0 最后一环:通用交易流 + 成本/盈亏** —— 还回答不了"我赚亏多少",当前最大缺口。

## 依赖 / 执行顺序(按解锁度)

```
✅ M7.1 定价 ─ ✅ M8.1 分析 ─ ✅ M8.3 多法币 ─ ✅ M9.1 Bitcoin      ← 已交付
        └─→ ⬜ M7.2 交易 ─→ ⬜ M7.3 盈亏 ─→ ⬜ M9.3 税务/报表        ← 下一主轴
（可并行小项)🟡 M8.1 尾巴 · 🟡 M8.2 时间范围 · ⬜ M8.4 告警 · ⬜ M9.1 其余覆盖 · 🟡 M10.x 打磨
```

**下一刀 = M7.2 交易流 → M7.3 盈亏**:Tier-0 就差这最后一环,做完才真正回答"赚亏多少"。

## 架构就绪度

`provider.inputs + creds + 注册表`让**加数据源很便宜**(M9.1 多为新 provider 包,如 Bitcoin 已循此路)。per-user 代币层 / 参考层 / 快照逐资产价均已就位(代币身份 epic #176 已收口)。**真正的大件只剩一块:`transactions` 表 + 摄取 → cost-basis/P&L 层**(schema 前提已备,`snapshot_balances` 已逐资产存 `usd_value`/`self_price`)。其余多为在既有契约上叠加。

## 不在本路线内(明确不做 / 远期)

- 社交 / 关注他人钱包、链上交易执行 / 签名(Folio 只读追踪,无私钥)、做市 / 交易终端、移动原生 App、多用户协作。超出"个人自托管 portfolio"定位。

## 对标参照

- **Zerion / DeBank**:链上 + DeFi 明细 + 多链(→ M9.1)。
- **CoinStats**:CEX + 链上 + 告警 + 多法币(多法币已 ✅ → 告警 M8.4)。
- **Rotki**:自托管 + 成本基础 / 税务 / 隐私(最贴定位 → M7.3 / M9.3 / M10.1)。
