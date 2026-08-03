# 多 Portfolio:总览按「选中的 Portfolio」聚合

用户需要**观察一个账户但不让它计入净值**:观察账户仍持续同步、仍能看它自己的持仓与历史曲线,但**不进总额、也不进首页的代币 / Perps / DeFi / 构成等聚合展示**——除非用户主动把它归到某个分组里看。

现有 `archivedAt`(归档)只做到一半:归档账户确实不计总额,但它**同时停止同步、冻结数据**——不满足「继续观察」。往「加个 `excludeFromTotal` 布尔」方向走也不够:布尔能不计总额,但做不到「从代币列表也隐藏、却在别处可看」。

**决定:引入 Portfolio(命名账户集),总览按「当前选中的 Portfolio」聚合。** 顶层净值 = 选中 Portfolio 的 Σ,默认选中 **My Portfolio**;「观察」不是账户的特殊状态,而是**把账户放进另一个 Portfolio**(如 Watch)的自然结果——它不在 My 的视图里,自然不进 My 的总额 / 代币 / Perps。具体:

- **Portfolio = 命名的账户集合**(per user:id / name / is_default / sort)。总览、代币 Tab、Perps、DeFi、构成、Insights、**历史净值曲线**全部**只聚合选中 Portfolio 的成员账户**。
- **顶层净值 = 选中 Portfolio 的总额**,默认选中 My Portfolio。切到 Watch 就看 Watch 自己的总额 / 代币 / 曲线。不做「所有非 Watch Portfolio 之和」这种隐式合并——**选中即视图**(要「全部(除 Watch)」的合并视图,后续再加,不在本轮)。
- **账户 ↔ Portfolio 归属:一对一(Phase 1)** —— 账户表加 `portfolio_id`,每个账户恰属一个 Portfolio。My / Watch 互斥。「以后分 group」= 再建一个 Portfolio、把账户移过去。**多对多(一个账户同进多个 Portfolio)本轮不做**(YAGNI:现在用不上,且会引出「哪份是净值」的歧义);真需要时加 join 表,可逆。
- **聚合边界统一,一处定义** —— 现有过滤集中在 `apps/web/src/lib/server/portfolio.ts` 的三处 `filter(a => a.archivedAt == null)`(喂 `buildOverview` / `buildPortfolioHistory`)。改成 `未归档 && 属于选中 Portfolio`,抽成一个 `accountsInView(all, portfolioId)` helper,总额 / 构成 / 曲线共用同一判据,数字不自相矛盾。
- **与归档正交,三态各管一件事** —— **活跃**:同步 ✓ 可见 ✓ 计入所在 Portfolio;**观察**:同步 ✓ 可见 ✓ 但归到非默认 Portfolio → 不进 My 视图;**归档**:停同步 ✗ 冻结保留、不进任何视图。「在某视图里」= 属于选中 Portfolio **且** 未归档。归档不改,只加 Portfolio 这一维。
- **历史曲线随「当前成员」追溯** —— 曲线由各账户快照(按账户存,ADR 与现状不变)按 Portfolio 成员聚合;成员旗标在账户上、不在快照上 → 把账户移进/移出 Portfolio,该 Portfolio 的整条曲线**追溯性**重算(直觉:这钱在这个视图里从来算/不算)。**账户自己的曲线始终保留**(在账户详情看),观察账户照常同步 → 它自己的曲线不断。
- **UI(Phase 1)** —— 总览顶部一个 **Portfolio 切换器**(默认 My,可切、可 +新建);账户页给每个账户选归属 Portfolio。新建账户默认落 My,可移动。

## Consequences

- **净值语义变了**:从「全账户(除归档)Σ」变成「选中 Portfolio Σ」。默认选 My + 现有账户全归 My → 对老用户**行为不变**(打开还是看到全部)。把某账户移到 Watch 才开始「从 My 消失」。
- **一处过滤扩散到所有聚合视图**:因为总额 / 代币 / Perps / DeFi / 构成 / 曲线 / Insights 都源自 `accountsInView`,加一个 `portfolioId` 维度即全线一致;这也是为什么坚持**单一事实源过滤**而非各视图各自判。
- **迁移**:新增 `portfolios` 表 + `accounts.portfolio_id`。两种落地取舍(留给 spec 定):① `portfolio_id` **可空、null = 默认 My(虚拟)**——最小迁移(一列 + 一表)、无需为每用户 seed、null 桶即 My;代价是 My 不是真行、改名/排序要特判。② 为每用户 **seed 一行 My + 回填** `portfolio_id`——数据模型更干净(My 是真行、可改名),代价是迁移要在 SQL 里生成 id(`hex(randomblob(16))`)并按 user 回填。均为**增量、可自动应用、非破坏**(不删列不删数据)。倾向 ①(最小),My 改名是 nice-to-have。
- **观察 = 放进非默认 Portfolio**,不引入账户的 `is_watch` 特殊类型:少一个概念,「Watch」只是个用户命名的 Portfolio。
- **分享 / 导出**按选中 Portfolio 的视图走(account-share 现有逻辑顺延到 portfolio 维);细节留 spec。
- **本轮不做**:多对多 group、「全部(除 Watch)」合并视图、Portfolio 级的目标/预算等——先把「命名账户集 + 选中聚合 + My/Watch」的地基打对。

关联:#135(归档语义,正交先例)、`apps/web/src/lib/server/portfolio.ts`(聚合边界)、`buildPortfolioHistory`(曲线随成员集)。
