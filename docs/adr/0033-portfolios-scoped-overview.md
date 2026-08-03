# 多 Portfolio:总览按「选中的 Portfolio」聚合

用户需要**观察一个账户但不让它计入净值**:观察账户仍持续同步、仍能看它自己的持仓与历史曲线,但**不进总额、也不进首页的代币 / Perps / DeFi / 构成等聚合展示**——除非用户主动把它归到某个分组里看。

现有 `archivedAt`(归档)只做到一半:归档账户确实不计总额,但它**同时停止同步、冻结数据**——不满足「继续观察」。往「加个 `excludeFromTotal` 布尔」方向走也不够:布尔能不计总额,但做不到「从代币列表也隐藏、却在别处可看」。

**决定:引入 Portfolio(命名账户集),总览按「当前选中的 Portfolio」聚合。** 顶层净值 = 选中 Portfolio 的 Σ,默认选中 **My Portfolio**;「观察」不是账户的特殊状态,而是**把账户放进另一个 Portfolio**(如 Watch)的自然结果——它不在 My 的视图里,自然不进 My 的总额 / 代币 / Perps。具体:

- **Portfolio = 命名的账户集合**(per user:id / name / is_default / sort)。总览、代币 Tab、Perps、DeFi、构成、Insights、**历史净值曲线**全部**只聚合选中 Portfolio 的成员账户**。
- **顶层净值 = 选中 Portfolio 的总额**,默认选中 My Portfolio。切到 Watch 就看 Watch 自己的总额 / 代币 / 曲线。不做「所有非 Watch Portfolio 之和」这种隐式合并——**选中即视图**(要「全部(除 Watch)」的合并视图,后续再加,不在本轮)。
- **账户 ↔ Portfolio 归属:关联表,先锁一对一** —— **不动 `accounts` 表**,归属走独立关联表 `portfolio_accounts(portfolio_id, account_id)`,`UNIQUE(account_id)` 强制**一对一**。**显式归属**:每个账户都有一行归属(现有账户 backfill 成 `(My, account)`),查询统一(`accountsInView` = join 关联表按 portfolio 过滤)。「以后分 group / 多对多」= **去掉 `UNIQUE(account_id)` 唯一约束**即可(一个账户可多行归属)——`accounts` 表始终不动、无数据迁移。本轮 YAGNI 只做一对一,但地基已按可平滑升 M:N 铺好。
- **聚合边界统一,一处定义** —— 现有过滤集中在 `apps/web/src/lib/server/portfolio.ts` 的三处 `filter(a => a.archivedAt == null)`(喂 `buildOverview` / `buildPortfolioHistory`)。改成 `未归档 && 归属选中 Portfolio`(经 `portfolio_accounts` join),抽成一个 `accountsInView(all, portfolioId)` helper,总额 / 构成 / 曲线共用同一判据,数字不自相矛盾。
- **与归档正交,三态各管一件事** —— **活跃**:同步 ✓ 可见 ✓ 计入所在 Portfolio;**观察**:同步 ✓ 可见 ✓ 但归到非默认 Portfolio → 不进 My 视图;**归档**:停同步 ✗ 冻结保留、不进任何视图。「在某视图里」= 属于选中 Portfolio **且** 未归档。归档不改,只加 Portfolio 这一维。
- **历史曲线随「当前成员」追溯** —— 曲线由各账户快照(按账户存,ADR 与现状不变)按 Portfolio 成员聚合;成员旗标在账户上、不在快照上 → 把账户移进/移出 Portfolio,该 Portfolio 的整条曲线**追溯性**重算(直觉:这钱在这个视图里从来算/不算)。**账户自己的曲线始终保留**(在账户详情看),观察账户照常同步 → 它自己的曲线不断。
- **UI(Phase 1)—— 一个全局顶部选择器,渐进式显示** —— 主页 / 账户页 / Insights **共享同一个顶部 Portfolio 选择器**(住 `_authed` 布局层),选谁三页都 scope 到谁:主页 = 该 Portfolio 净值 / 代币 / Perps,账户页 = 该 Portfolio 的账户(**不再有单独 tab**),Insights 同源。**账户页不设 portfolio tab**——选择器即作用域。
  - **选中不持久化**:刷新 / 重开回**默认 Portfolio**(`portfolios.is_default`,每用户恰一个、可改、默认 My);选择器是**临时切换**(会话内经客户端态 / URL 共享给三页,硬刷新回默认)。
  - **渐进式显示**:只有一个 Portfolio 时,三页都**不显示选择器**(和今天完全一样);**≥2 才浮现**。
  - **归属入口 = 账户侧边栏(抽屉)的「更多」菜单 → 移到 Portfolio(My / 某命名 / 新建…)**。用户流程是**先加账户(落当前选中,默认 My)、再从抽屉「更多」归到别的 / 新 Portfolio**——「观察一个账户」就是这个动作,「移到 → 新建」一步完成创建命名 Portfolio + 归属,选择器随之出现(解掉「≥2 才显示」的先有鸡先有蛋)。
  - **新建账户落在当前选中的 Portfolio**(在 Watch 视图里加即进 Watch)。
  - **「空 Portfolio 不存在」= 命名 Portfolio 空了自动删** —— 移走 / 删掉其最后一个成员账户时,该命名 Portfolio 自动消失(名字随之没了);故**没有空态**,用户永远不会看到一个空 Portfolio。**默认 Portfolio(My)例外**:是持久的兜底家,不自动删、不可删;把成员全移走的退化情形下它可为空(罕见,显 $0,不特判)。
  - **管理挂选择器菜单**:改名(含 My,因是真行)/ **设为默认** / 显式删除(= 把成员退回默认再移除该行)。

- **删除既有(未用)的 groups 概念** —— 代码里已有一套用户自定义 `groups` + `account_groups`(M:N,总览显示各组小计、账户页勾选入组),但**实际零使用**(本地 D1 `groups`/`account_groups` 均 0 行)。它是**加法**(每账户都进总额、组只加小计),与本轮的**作用域/减法** portfolio 语义不同,并存会让账户页出现两套「账户集」。故**整套移除**(`groups`/`account_groups` 两表 + `groups.ts`/`groups-view.ts`/db 的 `createGroup`/`listGroupsByUser`/`accountGroups` ops + 总览 ByGroup 区 + 账户页入组 UI),让 **portfolio 成为唯一的「账户集」概念**。注:`source-groups.ts`(按来源/平台分组持仓)是另一回事,保留。

## Consequences

- **净值语义变了**:从「全账户(除归档)Σ」变成「选中 Portfolio Σ」。默认选 My + 现有账户全归 My → 对老用户**行为不变**(打开还是看到全部)。把某账户移到 Watch 才开始「从 My 消失」。
- **一处过滤扩散到所有聚合视图**:因为总额 / 代币 / Perps / DeFi / 构成 / 曲线 / Insights 都源自 `accountsInView`,加一个 `portfolioId` 维度即全线一致;这也是为什么坚持**单一事实源过滤**而非各视图各自判。
- **迁移(定:seed 真 My 行 + 关联表,不动 accounts)**:新增 `portfolios` 表 + `portfolio_accounts` 关联表(`UNIQUE(account_id)`),**`accounts` 表零改动**。给**每个现有用户** seed 一行默认 Portfolio(`is_default=1`),**名字 = `<用户名>'s Portfolio`**(取 `user.name`;name 为空时兜底 `My Portfolio`),真行、可改名;并给该用户每个现有账户 backfill 一行归属指向它。id 在 SQL 迁移里用 `lower(hex(randomblob(16)))`(id 列是 TEXT、不强制 UUID 格式)。**新用户 / 新账户**由 app `ensureDefaultPortfolio(userId)` + 建账户时插归属行兜底——迁移管存量、app 管新增,人人有 My、每账户恰一行归属。增量、可自动应用、非破坏。**升 M:N** 时只删 `UNIQUE(account_id)`,accounts 表与既有归属行均不动。
- **观察 = 放进非默认 Portfolio**,不引入账户的 `is_watch` 特殊类型:少一个概念,「Watch」只是个用户命名的 Portfolio。
- **分享 / 导出**按选中 Portfolio 的视图走(account-share 现有逻辑顺延到 portfolio 维);细节留 spec。
- **本轮不做**:多对多 group、「全部(除 Watch)」合并视图、Portfolio 级的目标/预算等——先把「命名账户集 + 选中聚合 + My/Watch」的地基打对。

关联:#135(归档语义,正交先例)、`apps/web/src/lib/server/portfolio.ts`(聚合边界)、`buildPortfolioHistory`(曲线随成员集)。
