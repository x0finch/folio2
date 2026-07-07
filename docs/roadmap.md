# Folio Roadmap — 叙事 / 范围 / 依赖

> 前向 **epic 看板 = [GitHub Project #1 "Folio Roadmap"](https://github.com/users/x0finch/projects/1)**(一里程碑一 issue、`roadmap` 标签、Tier 分层,进度事实源)。
> 本文只留看板放不下的**叙事、依赖、范围边界**;开工某条 epic 时经 `to-issues` 拆竖切片。已交付功能的历史见 git log + [docs/adr/](adr/)。

## 现状一句话

Folio 今天是**带统一定价 + 多币种展示 + 分析拆分**的多源组合追踪器:链上 / CEX / perp / manual / **Bitcoin(地址 + xpub)** 余额 → 归一 USD → **canonical 代币聚合** → 展示(24h 涨跌 / 占比 / 单资产 drill-down / 净值曲线),可切法币或 BTC/ETH 计价。DB 已从最初 5 表长出代币参考层(tokens/index/meta/groups)、平台元信息(platforms)、FX 汇率(fx_rates)、manual 活动(manual_activity)。`snapshot_balances` 存逐资产 `unit_price`。

**仍缺 Tier-0 最后一环:通用交易流 + 成本/盈亏** —— 还回答不了"我赚亏多少",当前最大缺口。

## 依赖 / 执行顺序(按解锁度)

```
✅ M7.1 定价 ─ ✅ M8.1 分析 ─ ✅ M8.3 多法币 ─ ✅ M9.1 Bitcoin      ← 已交付
        └─→ ⬜ M7.2 交易 ─→ ⬜ M7.3 盈亏 ─→ ⬜ M9.3 税务/报表        ← 下一主轴
（可并行小项)🟡 M8.1 尾巴 · 🟡 M8.2 时间范围 · ⬜ M8.4 告警 · ⬜ M9.1 其余覆盖 · 🟡 M10.x 打磨
```

**下一刀 = M7.2 交易流 → M7.3 盈亏**:Tier-0 就差这最后一环,做完才真正回答"赚亏多少"。

## 架构就绪度

`provider.inputs + creds + 注册表`让**加数据源很便宜**(M9.1 多为新 provider 包,如 Bitcoin 已循此路)。代币层 / 平台层 / FX 层 / 快照逐资产价均已就位。**真正的大件只剩一块:`transactions` 表 + 摄取 → cost-basis/P&L 层**(schema 前提已备,`snapshot_balances.unit_price` 已存)。其余多为在既有契约上叠加。

## 不在本路线内(明确不做 / 远期)

- 社交 / 关注他人钱包、链上交易执行 / 签名(Folio 只读追踪,无私钥)、做市 / 交易终端、移动原生 App、多用户协作。超出"个人自托管 portfolio"定位。

## 对标参照

- **Zerion / DeBank**:链上 + DeFi 明细 + 多链(→ M9.1)。
- **CoinStats**:CEX + 链上 + 告警 + 多法币(多法币已 ✅ → 告警 M8.4)。
- **Rotki**:自托管 + 成本基础 / 税务 / 隐私(最贴定位 → M7.3 / M9.3 / M10.1)。
