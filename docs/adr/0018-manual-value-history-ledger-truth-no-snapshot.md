# manual 价值历史:账本为真 + compute-on-read,manual 账户不写 snapshot

Folio 每个账户每次 sync 都写一行不可变 `snapshots`(冻结当时 `totalUsd`),组合净值曲线由 `buildPortfolioHistory` 把「各账户截至 T 最近一次 snapshot」阶梯式求和重建(`apps/web/src/lib/history.ts`)。manual 账户至今也走这套 —— 其历史 = 历次 sync 时 `amount × price` 的冻结值。但 manual 本质是一本**可追溯编辑的账本**:用户会补录/修改/删除**过去**的活动(「其实我三月就卖了 0.5」)。冻结 snapshot 无法回改,导致改动只影响「当下往后」,过去曲线仍是旧持仓 —— 与账本语义矛盾(原 #149)。

决定:**manual 账户的价值历史改由账本推导(compute-on-read),不再来自 snapshot;且 manual 账户彻底不写 snapshot** —— 其「当下」持仓与净值在读时从 `creds.tokens`(= `manualProvider.fetchBalances` 的产物)现造。`value@T = quantity@T × price@T`,其中 `quantity@T` = 折叠 `occurredAt ≤ T` 的活动;改/删任一过去活动 → 下次读自动得新曲线,**永不留 stale snapshot**。

- **price@T 的源(降级链)**:① 有 identifier → oracle 历史价(#148),真实盯市曲线,与 synced 账户及 ADR 0010/0017「市价重估」一致;② 无 identifier / #148 未就绪 → 账本中「`occurredAt ≤ T` 最近一条活动记录的 `price`」;③ 再无 → 当前 `unitPrice` 摊平。**故 #148 是质量升级而非硬阻塞** —— compute-on-read 可先用 ② 落地跑通,#148 落后把有 identifier 的 holding 切到 ①。
- **组合曲线不需特殊合并**:`buildPortfolioHistory` 本就是「各账户阶梯序列按时间求和」。manual 只是**换供货源** —— 别的账户的 `(takenAt, totalUsd)` 行来自 snapshot 表,manual 的来自账本现算,拼在一起喂同一个函数。manual 不在 snapshot 表 → 不会被算两遍。
- **缓存只放价格层**:过去某天的历史价不可变 → 在 #148 的 oracle 层按 `ref + 日期桶` 长/永久 TTL 缓存(复用现有 D1 参考缓存 `cache-util.ts` 那套)。账本折叠便宜、每次编辑即失效,**不缓存**;**「缓存组装好的 manual 曲线」= 物化(方案 B),不提前做**。

## Considered Options

- **历史存储:compute-on-read(选)vs materialize + 从编辑日往后失效(方案 B)** —— B 让 manual 也写「可重写」的 snapshot 行(改过去活动即删该日起往后、按账本重算重写),`buildPortfolioHistory` 零改动;但要给过去时刻造 snapshot(时间戳放哪?)、写路径复杂(删+重算+重写),且提前吃下物化成本。选 A(compute-on-read)先落地,**账本大了 / profiling 证明组装是热点再升 B**。
- **当下值来源:manual 停写 snapshot、当下持仓从 creds 现造(做法 1,选)vs manual 照写 snapshot、仅历史构建绕开它(做法 2)** —— 做法 2 blast radius 最小(overview/账户页一字不改),但留着用不上的冗余 manual snapshot;做法 1 端状态最干净(manual 彻底退出 snapshot / snapshot_balances)。选做法 1,靠「一处收口」把成本控住(见 Consequences)。
- **价 @T 用真实市场价 vs 账本记账价** —— 组合是净值**追踪器**,过去净值应是市值 → 首选 oracle 历史价(市值),账本记账价仅作无 oracle ref 时的降级,不作首选。

## Consequences

- **当下值读路径需注入合成 manual 余额**:`getMyOverview` / `getMyAccountHoldings` / `getPortfolioHistory` 的「此刻」点都吃同一张「每账户最新 snapshot」表(`getLatestSnapshotByUser` → `byAccount`)。manual 不写 snapshot 后,须在**拼 `byAccount` 处**为 manual 账户注入一份从 `creds.tokens` 现造的合成 `SnapshotWithBalances`(= provider 输出;`selfPrice=null` 走盯市,与 manual 现行为一致)。收口为**一个共享工具 + 三处一行替换**,不散落。
- **manual 退出 snapshot / snapshot_balances**:这两表不再有 manual 账户的行;任何「遍历所有账户 snapshot」的逻辑对 manual 为空是预期。
- **回溯编辑天然正确**:改/删过去活动后曲线整体重算,无 stale;这正是选 compute-on-read 的核心收益。
- **每次历史读的成本** = 折叠账本(廉价)+ 取 price@T(经缓存的历史价)。若日后 profiling 显示组装是热点 → 升方案 B(物化 + 从编辑日往后失效),届时的缓存即 B 的物化产物。
- **依赖**:准确市值曲线依赖 #148(oracle 历史价);但因降级链,#148 不阻塞 compute-on-read 骨架落地。
