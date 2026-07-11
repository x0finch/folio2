# 展示 note:两级(account 手风琴 / balance 图标+popover),取代 DetailBlock 词汇表

Status: accepted — 取代 [ADR 0010](0010-kind-governance-two-layer-meta-detail.md) 决策 #5(detail 渲染 = DetailBlock「画法 type + format」词汇表)。0010 的 kind 治理(粗粒度 4-kind)、两层 meta/detail 的**分界原则**不变;变的是展示层的**形态、命名、级别**。经 grill-with-docs 定案 + 与 markdown spike(#68)对比后胜出(#69,#43)。

## 背景

0010 把 provider 展示细节设计成 `detail?: DetailBlock[]` —— 每块自带**画法原语**(`type`: stat/keyValue/addressList/… + `format` 枚举),前端一个 `<BalanceDetail>` 按 `type` 分发。实做中发现:

- 真实场景只有两类数据(BTC 钱包地址/未确认、CEX 锁仓/冻结),`type`×`format` 词汇表是**为不存在的多样性预设的框架**(YAGNI);封闭词汇表每加一种画法仍要改前端,并没消除「加详情要动前端」。
- 「detail」一词太泛,且与 manual 账本已有的**用户手写备注**(`manual_activity.note`)概念冲突。
- 展示细节其实分**两种作用域**:BTC 的地址/派生分布描述的是**整个钱包/xpub**(账户级,今天恰好单 balance,但面向未来多-balance 钱包);CEX 锁仓描述的是**这一笔持仓**(余额级)。0010 一律 per-balance 抹平了这个区别。

## 决策

1. **命名 `detail` → `note`**;为腾出该词,manual 账本的用户备注 `note` 改名 `memo`(功能不变)。`note` = provider 生成的**仅供展示、无共享逻辑读**的分段。

2. **弃 DetailBlock 词汇表**。一个 `Note` 是**固定结构**的一段:`{ title, icon?, content: string | NoteRow[] }`;`NoteRow = { label, value?, unit?, href? }`;`icon` 为 5 个中性状态名(info/success/warning/error/help)。**无 `type` 画法判别、无 `format` 枚举**。数字即数字,locale 格式化由前端注入的 `formatNumber` 做;label/title 英文字面(结构保留,将来可 i18n)。

3. **两级 note**:
   - **account 级** `Note[]`(整钱包):`fetchBalances(ctx) → { balances, note?: Note[] }` 顶层返回,落 `snapshots.note`。BTC(blockbook)产未确认/收款地址/派生分布多段。
   - **balance 级** 单个 `Note`(这笔持仓):挂 `Balance.note`,落 `snapshot_balances.note`。CEX(binance/okx)每锁仓/冻结币产一段。

4. **渲染**(在 `@folio/notes-react` React 包,不反依赖 app;数字格式化由 app 注入):
   - account 级 → beUI **BouncyAccordion**,一段一个 item(icon+标题,展开体 = `<NoteView>` 内容)。
   - balance 级 → 现货行标题右侧一个**小状态 icon**(`<NoteIndicator>`),**hover** 开 beUI **Popover** 显 `<NoteView>`(段标题 + content);内容超长 popover 内部滚动,无 modal。打开时 Popover root 抬 z-50(beUI popover 非 portal,否则被后续不透明行盖住)。

5. **beUI 原语经 registry 引入、不手改**:`@beui/popover` 落 `@folio/ui`,保持 `shadcn add` 原样(原则 #11)。

## Considered Options

- **markdown 字符串,前端 react-markdown 直接渲染**(#68,作为并行对比 spike 真做出来)—— 最省事,但丢结构:数字/单位写死在 provider 串里,绕过 locale 数字格式化与将来 i18n;样式脱离 beUI;第三方 provider 吐 markdown 有 XSS 面。结构化 `note`(本 ADR)胜出:保留结构 → 数字跟随 locale、标签可后加 i18n、样式走设计系统、无 XSS。**#69 胜 #68。**
- **保留 0010 的 DetailBlock `type`/`format` 词汇表** —— 对两类真实数据过度设计,封闭词汇表并未消除「加画法改前端」。否(收敛为单一固定 `Note` 结构)。
- **detail 一律 per-balance(不分级)** —— BTC 恒单 balance 时与账户级无法区分,但钱包级 detail(地址/派生)概念上属账户、面向未来多-balance 钱包;分两级更贴语义。选两级。
- **balance note 用文字 badge / click 触发 / 配 modal** —— badge 太占地、click+可滚动面板体验一般、modal 对「一行数据」过重。收敛为**小 icon + hover popover(可滚)**,无 modal(YAGNI)。

## Consequences

- **契约** `@folio/connectors-basic`:`DetailSection/Row/Icon` → `Note/NoteRow/NoteIcon`(`detail-block.ts`→`note.ts`);`Balance.note` 单个;`fetchBalances` 返回 `{ balances, note?: Note[] }`(所有 provider 随之改;非 note provider 返回 `{ balances }`)。
- **sync/db**:`FetchOutcome.note`;新增 `snapshots.note` + `snapshot_balances.note`(迁移 0019);`manual_activity.note → memo`。
- **渲染包**:`@folio/detail-block` → `@folio/notes-react`,`NoteView` / `NoteIndicator` / `NoteIconGlyph`(原 `HoldingDetail`/`<BalanceDetail>` 弃)。
- **web**:account-view / overview 两级透传;holdings-cards 顶部 account 手风琴 + 现货行 balance icon。
- DetailBlock 词汇表(stat/keyValue/addressList/format)从未落地,无迁移负担。
