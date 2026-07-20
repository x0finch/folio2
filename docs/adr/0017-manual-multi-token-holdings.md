# manual 账户多 token:`manual_holding` 表 + per-holding 活动账本

Folio 的 manual 连接器原本**一个账户 = 一个手记 token**:持仓 `symbol/amount/unitPrice/identifier` 全塞在扁平的 `account.creds` 标量 map 里,`amount` 由**账户级** `manual_activity` 账本 `deriveAmount` 后物化进 `creds.amount`,`manualProvider.fetchBalances` 据此产**单条 spot**。为支持「一个 manual 账户持有多个 token」,决定**新增 `manual_holding` 表**(每 token 一行:`symbol/unitPrice/identifier`),把 `manual_activity` 从账户级改为**挂 `holding_id`**(每 token 各自 add/reduce/set 账本、各自 `deriveAmount`);app 把「各 holding 定义 + 各自推导 amount」序列化成一个 public JSON 字段 `creds.tokens`,供**保持纯/DB-free 的** `manualProvider` 读取并产 **N 条 spot**。估值仍 `mark-to-market`。

## Considered Options

- **token 数组塞进 `creds` 的一个 JSON 字段(不加表)** —— 少一张表,但把结构塞进本为**扁平标量字段**设计的 creds 模型:per-field 加密、`safeView`、`isComplete`、`credentialSpecs()`、加账户表单全依赖扁平结构,活动只能按 token 字符串标识关联(symbol 改名即断)。被否。
- **每 token 拆成独立账户** —— 与用户诉求(一个 manual 账户聚合多 token)相悖,且撑爆账户列表。被否。
- **provider 直接读 DB 取多 token** —— 违反 connector「纯 / DB-free / 契约统一」(原则 #1/#3/#6)。被否;改由 app 物化进 `creds.tokens`,沿用现有 `materializeAmount` 同一套「app 把账本结果物化进 creds 供 provider 读」的既有模式。

## Consequences

- **Schema 迁移(难回退)**:建 `manual_holding` 表 + `manual_activity.holding_id` 列;对现有单 token manual 账户做 backfill —— 每个建一行 holding(取旧 creds 的 `symbol/unitPrice/identifier`)、其活动行 `holding_id` 指向该 holding、creds 旧标量重写成 `tokens=[{…}]`。旧 `symbol/amount/unitPrice/identifier` 标量退场。
- **不变量**:`creds.tokens[i].amount === deriveAmount(holding i 的 activities)`;`materializeAmount` 从账户级改为 **per-holding**(单写者,受影响 holding 才重算)。
- **批量录入的原子校验**:一次提交多条活动时,服务端按 `occurredAt`→`createdAt` **逐 holding** 折叠,任一 `reduce` 在其时点超运行持有 → 整批拒(`db.batch` 原子)。
- **`creds.tokens` 是物化投影而非事实源** —— 事实源是 `manual_holding` + `manual_activity` 两表;任何写路径改动都须重跑物化,否则 provider 读到陈旧持仓。
- 远超原 #108 的 UI 范围 → 拆成数据模型 / provider+物化 / 服务端 fn / Tokens-tab UI / Activity-tab UI 多个竖切片各自 PR。
