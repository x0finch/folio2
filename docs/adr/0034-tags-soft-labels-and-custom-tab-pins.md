# Tags(Portfolio 内软标签)+ 首页自定义 Tab(pin)

> **「pin 名单不按组合筛」与「connector 账户删光后留着显示空 section」两条已被取代**:见 [ADR 0047](0047-scoping-happens-on-the-server.md) —— pin 名单按当前组合筛(服务端算),上限也从每用户 3 个改成每组合 3 个。本 ADR 其余部分不变。

用户需要**在一个 Portfolio 内部横切分组**账户:同一批账户,时而想按「长线 / 短线」看,时而想按「链上挖矿 / 稳定币池」看——这些分组**互相重叠、一个账户可同时属于多个**,且随时增删。现有的 [Portfolio](0033-portfolios-scoped-overview.md) 解决不了:它是**硬隔断**(账户 1:1 归属、`UNIQUE(account_id)`),一个账户只能在一个 Portfolio 里,不是拿来做重叠软分组的。早先那套 `groups`(M:N、加法语义)已在 #336 整套删除,且语义(每账户都进总额、组只加小计)与本需求也不同。

**决定:引入 Tag(Portfolio 内的软标签)做重叠分组;首页新增自定义 Tab,作为「指向某 Connector 或某 Tag」的薄 pin(而非可组合的保存视图)。** 两者都在**当前选中 Portfolio 内**生效。

## Tag

- **Tag = 账户的软标签**,M:N(一账户多 Tag),做横切分组用。**归属某个 Portfolio**(`tags.portfolio_id`)——账户只能打其所在 Portfolio 的 Tag。是 Portfolio **内**的再分组,不是硬隔断。
- **数据**:`tags`(userId-scoped:`id / user_id / portfolio_id / name / sort_order / created_at`)+ `account_tags`(`tag_id, account_id` 复合主键)。刻意**仿 `portfolios`/`portfolio_accounts` 的范式**,唯一差异是 `account_tags` **不加 `UNIQUE(account_id)`**——Tag 天生 M:N。删 Tag → FK 级联删 `account_tags` 行。
- **名字同 Portfolio 内唯一**:去空格、大小写不敏感(`UNIQUE(user_id, portfolio_id, lower(name))`)。跨 Portfolio 不限(A 的「长线」与 B 的「长线」是两个独立 Tag,符合归属模型)。理由:同名 Tag 用户分不清,且颜色按 id hash、同名还可能不同色。
- **不变量:账户 move 到别的 Portfolio → 清空其 Tag**(删该账户的 `account_tags` 行,在 move 那个 batch 里顺手做)。Tag 是 Portfolio 内概念,带过去会破坏「账户只有其所在 Portfolio 的 Tag」;新家里重新打即可。attach 时校验账户与 Tag 同 Portfolio。
- **颜色 = 对 Tag id 做 hash → `--chart-1..5`**(与 `allocation-pie.ts` 同一 token 池,只引 design token)。**自动、不可手改**;改名不变色(hash 对 id 不对 name)。撞色可接受(不像饼图相邻要区分);需要更宽再请设计扩到 `--chart-1..8`。
- **增改删全内联在「打标签」modal**(账户详情抽屉 ⋯ 菜单入口):一个标签输入框——所有 Tag 平铺、点 chip 打上/取消、**点即生效**(乐观更新,无保存按钮);末尾输入框里正在打的字**本身长成待建 Tag**(虚线描边 + 预览色点),回车固化。右上「管理」切改名/删除行;删 Tag 是 **Portfolio 级破坏性操作**(从所有账户摘掉 + 级联删 pin)→ 二次确认,文案讲清「将从 N 个账户移除」。
- **展示**:账户行最多平铺 2 个彩色 badge,余下收 `+N`;账户详情抽屉在 label 下单独一行展示全部。

## 首页自定义 Tab(pin)

- **自定义 Tab = 薄 pin**,指向**单个 Connector 或单个 Tag**;名字与颜色**借用**所指对象,不自存。刻意**不是**可组合多条件、可单独命名的「保存视图」——用户的诉求只是「固定某个 Connector / 某个 Tag 的快捷入口」,保存视图的灵活度用不上却要付双倍的命名/配色/一致性成本。
- **数据**:`tab_pins`(userId-scoped:`id / user_id / kind:'connector'|'tag' / tag_id?(FK→tags ON DELETE CASCADE) / connector_id? / sort_order`)。**每 user 至多 3 个**(上限在 ops 层校验)。Tag 类 pin 靠 FK 级联在删 Tag 时自动消失;Connector 类 pin 的 `connector_id` 存字符串**不设 FK**(Connector 是代码 manifest、非表行),某 Connector 下账户被删光时该 pin **留着显示空 section**,不自动删。为什么用表而非塞进用户设置 blob:删 Tag 要能级联清 pin、排序与上限要能约束,一张表比手写 blob 维护干净,且与 Portfolio 范式一致。
- **作用域:当前选中 Portfolio 内**再按 Connector / Tag 筛(与 [Portfolio](0033-portfolios-scoped-overview.md) 选择器叠加,不跨 Portfolio)。落点在既有单一事实源过滤层(`apps/web/src/lib/accounts-in-view.ts` + `server/portfolio.ts`)加一个维度。
- **版式分叉(刻意保留两种)**:默认 / Portfolio 视图**保留**现有的现货 / 永续 / DeFi 子 Tab,一行不动;**只有自定义 Tab** 改用**按小计倒序的 section list**(spot/perp/defi 三段竖排、哪段小计大哪段在上,复用 `SpotCards`/`DefiPositions`/`PerpPositions` + 加回 `SectionHeader`)。用户明确接受两种版式并存——因此现有首页与抽屉完全不碰,section list 是纯新增。
- **pin 的管理**:hover 固定 Tab 冒小 popover——「改」= 换它指向的 Connector/Tag;「删」= 取消固定。**删不二次确认**(只是取消 pin、不碰任何数据)。

## Consequences

- **迁移增量、非破坏**:新增 `tags` / `account_tags` / `tab_pins` 三表,**不动 `accounts` / `portfolios` / `portfolio_accounts`**。无存量 backfill(Tag 是新概念,老用户初始零 Tag、零 pin)。
- **过滤扩散一处**:自定义 Tab 的 Connector/Tag 筛加在 `accountsInView` 这一维,总额 / 代币 / 曲线随之一致——同 0033 的单一事实源理由。这是本轮唯一触碰既有聚合链路(SSR/SWR)的地方,需验证不破坏现有路径。
- **Tag 与 Portfolio 正交、层级清晰**:Portfolio = 硬隔断(选中即视图),Tag = Portfolio 内软标签(横切)。「用户自定义账户分组」这一概念现由 Tag 独占(`CONTEXT.md` 的 `group` avoid-note 已改指向 Tag)。
- **本轮不做**:Tag 参与 Insights 维度(Allocation/Composition 的 `dimension`)、跨 Portfolio 的 Tag、pin 组合多条件、给 pin/Tag 单独命名或改色、自定义 Tab 吃掉 Portfolio 选择器合成一排。先把「软标签 + 薄 pin + section list」的地基打对。

关联:[ADR 0033](0033-portfolios-scoped-overview.md)(Portfolio 硬隔断,本 ADR 的上层)、#336(删除旧 groups 的 prefactor)、`apps/web/src/lib/accounts-in-view.ts`(过滤单一事实源)、`allocation-pie.ts`(`--chart-*` 配色池)。
