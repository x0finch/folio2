# kind 治理修订:粗粒度资产类 + 两层 meta/detail(DetailBlock)

Status: accepted — 取代 [ADR 0009](0009-connector-manifest.md) 的 kind 治理部分(governing 定义、决策 #4「5-kind」、决策 #7「EVM」不涉;Considered Options #7「kind 分类法」;及 SpotMeta/`fixed`)。经 grill-with-docs 逐分叉压测定案(#43)。

## 背景

ADR 0009 把 `kind` 定义为「**一套独有的 meta + 渲染契约**」的扁平判别,终案 5-kind(`spot/defi/perp_equity/perp_position/utxo`)。connector 重写(epic #29)落地后,从 #32(utxo kind)/#34(CEX locked)的 review 里浮现两点张力:

- provider 专属的**展示细节**(BTC 未确认/派生地址/收款;CEX locked/available;将来 staking 到期、减半日期、LP 底层币、健康度…)被迫要么开新 kind、要么塞进 typed meta —— 都不理想。
- 详情触发靠 `tokenKey.startsWith("chain:bitcoin")` 这类**硬编码 per-asset 判断**,每加一种就多一个 `if`,会腐化。

`utxo` 其实并不满足旧「独有渲染契约」定义:代码里 BTC 在主表本就当现货聚合(`isFungible` 里 spot∪utxo 同口径、account-view 里 utxo 行进现货表),它「独有」的一切(pendingSats/派生地址/收款)全是**展示细节**,无一喂公共逻辑。

## 决策

1. **`kind` 治理定义改为「粗粒度资产类别」** —— 唯一职责是驱动**跨 connector 的公共逻辑**:①聚合口径(进不进首屏同质加总)②净值不变量(哪行承载 value)③主表/分区路由。**渲染差异不再由 kind 承载**(下沉 detail)。取代 0009 那句「独有 meta+渲染契约」的 governing 定义。

2. **kind 收敛为 4 个**:`spot / defi / perp_equity / perp_position`。**`utxo` 并回 `spot`**(取代 0009 决策 #4 的 5-kind);BTC 吐 `kind:"spot"`。

3. **删除 `SpotMeta` / `fixed`** —— manual 的「锁定固定值」当前未用到,整块移除:manual `account.creds.fixed` 字段、provider 的 `meta:{fixed:true}` 透出、`revalue` 的 fixed 特判、UI checkbox + i18n。`spot` 从此**零 typed meta**。manual 统一走市价重估(不可解析币仍回退 `amount×unitPrice`,行为不变)。无需迁移(manual creds public 明文、每 sync 重建,遗留 `fixed` 键孤儿化)。

4. **两层:typed `meta`(保留)+ `detail`(新增)**。分界:**共享逻辑/跨 provider 视图会结构化读它吗?会 → typed `meta`;只是某 provider 想展示、无共享逻辑读 → `detail`。**
   - `meta` 保持随 kind 精确的强类型、穷尽、禁 cast:`defi`(protocol/positionType,account-view 分组读)、`perp_equity`/`perp_position`(perp.ts 读)。
   - `detail?: DetailBlock[]` 落 `BalanceBase`,装 provider 专属**仅供展示**的细节。`UtxoMeta`/`Utxo` schema 删除,BTC 明细改由 detail 承载。

5. **detail 渲染 = 「结构化块 + 小组件」(方案 T2)**。每个 `DetailBlock` 自带「**画法(`type`)+ 数据**」、随数据一起走:
   - `type` 是**画法原语**(`stat`/`keyValue`/`addressList`/`table`/`note`),**不是**业务身份。
   - 值结构化(数字即数字);格式由块的 `format`(`sats`/`btc`/`usd`/`percent`/`date`/`address`)声明、**前端做** → 跟随显示币种/locale。标签用 **i18n key** → 跟随中英双语。
   - 类型定义落 **`@folio/connectors-basic`**(客户端安全、无 provider 运行时):provider import 拼块(编译期检查形状)、前端 import 渲染 → 单一源、不漂移、不把 provider 运行时拖进客户端 bundle。
   - 前端**一个 `<BalanceDetail blocks={detail}/>`** 按 `type` 渲染,**永不判断 BTC/CEX**(消灭 `startsWith("chain:bitcoin")`)。加 provider 详情 = 吐块,前端零改(除非需要全新画法 → 慎重往封闭词汇表加块类型)。
   - **交互烘进原语**(`addressList` 自带复制/二维码,实现一次);需可配交互 → 块带**具名字段/action**、handler 在前端;**块里绝无函数**。
   - 词汇表**封闭、小**;v1 落 `stat`/`keyValue`/`addressList`(BTC + CEX 够用),`table`/`note` 按需。

6. **前向兼容 = 老化,不迁移**(与 0009 的 balance.kind forward-only 一致)。`ViewKind` 去掉 `utxo` 收成 4;老 `kind:"utxo"` 行归 `spot`(主表数量/金额/聚合不变);老 `UtxoMeta` 明细不再解析、详情面板暂空、下次同步 blockbook 写 `detail[]` 自愈。顺手删 `viewKind` 的 `chain:bitcoin` 嗅探 + `utxo` 分支 + `parseUtxoMeta`。

## Considered Options

- **detail = markdown 字符串,前端直接渲染**（用户提议)—— 最省事、最「前端不判断」,但四坑:①复制按钮/二维码干不了;②provider 拼字符串 = 写死标签与单位,**绕过 i18n + 显示币种**(全站唯一不跟随语言/币种处);③样式脱离 beUI 设计系统;④将来第三方 provider 吐 markdown = XSS(ADR 0009 明确远期支持第三方)。否。
- **完整声明式 DSL(独立 spec + 路径绑定 + 注册表 + 格式/action 词汇表)**（#43 原文方案 3)—— 对现在 3–5 种块过度设计,是「自己造框架、后续维护重」。否(即 T2 之所以砍掉 spec/registry 那层)。
- **采用 [json-render](https://github.com/vercel-labs/json-render)(Vercel Labs)现成方案** —— 它 ≈ 上条完整 DSL 的成品版(catalog/registry/spec 树/数据绑定/typed action),15.6k stars 但 6 个月大、**0.19 pre-1.0**(breaking 期),设计中心是**AI 生成 UI**(我们没有的问题)。渲染组件两方案都得自己写,它只替掉 ~40 行 switch,却带来年轻 0.x 依赖 + 范式不匹配 → 对本窄需求**净增维护**;四闸(原则 #9)挂「复杂度值不值」「够不够稳」两关。否。**留后手**:若 detail 演变为「第三方吐任意详情 / AI 生成」,回评 json-render——那时它从「过度」变「正好」。
- **保留 `utxo` 作第 5 个 kind** —— 新 governing 定义下 utxo 不构成独立资产类(聚合/主表已骑 spot,独有的全是展示)。否。
- **`fixed` 留 `meta`(A)或 revalue 直读 account.creds(B)** —— 用户判定当前未用到,直接删(选项 C),不自找麻烦。
- **写迁移把老 utxo 快照转 spot+detail** —— 为下次同步即自愈的装饰性面板写一次性迁移,不划算。否(选老化)。

## Consequences

- **Balance 契约变更**(`@folio/connectors-basic`):删 `SpotMeta`/`Spot.meta`、`UtxoMeta`/`Utxo`/`utxo` 判别支;`BalanceBase` 加 `detail?: DetailBlock[]`;新增 `DetailBlock` 判别联合(词汇表 v1)。判别联合从 5-kind → 4-kind。
- **读端**:`balance-kind.ts` 的 `ViewKind` 收成 4、删 `chain:bitcoin` 嗅探 + utxo 分支;`account-view.ts` 删 `parseUtxoMeta`/`hasUtxoDetail`/`utxo` 分区,改渲染 `detail[]`;新增 `<BalanceDetail>` + 原语组件。
- **写端**:`providers/manual` 删 fixed;`providers/blockbook` 改吐 `kind:"spot"` + `detail:[…]`(BTC pending/地址/收款);binance/okx 后续吐 locked/available 块。
- **`revalue.ts`**:删 fixed 特判。
- **分期(见 to-spec/to-tickets)**:P1 契约(detail 袋 + DetailBlock v1 + `<BalanceDetail>` + 原语组件)+ kind 收敛;P2 blockbook BTC detail;P3 CEX locked/available。各片独立可验收、可合并。
- **CONTEXT.md**:新增 `kind`/`meta`/`detail`/`DetailBlock` 词条。
- 历史时间线只用 `totalUsd`,不受影响;当前持仓来自最新快照。
