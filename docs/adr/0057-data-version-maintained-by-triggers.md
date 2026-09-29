# 0057 — 数据版本号由触发器维护;重建相关表的迁移必须先删后建触发器

日期:2026-09-29。状态:已接受。FOL-94(补记:决定随迁移 0010 落地,当时只写在 schema 注释里)。

## 背景

浏览器把查询缓存存进 IndexedDB,回到页面只问一个数 —— 这个用户的数据版本号(`user_data_version.version`,`getDataVersion`),变了才重拉。这个数必须在「用户看得见的数据」每变一次时 +1,少抬一次就是用户看着旧数据不自知。

FOL-94 原本写的是「在写的那个 `db.batch` 里一起加」:每个写 op 自己记得抬。

## 决定

**不靠各个写 op,靠 SQLite 触发器**(迁移 `packages/db/drizzle/0010_user_data_version.sql`,手写;drizzle-kit 不管触发器)。每张装着「谁的」可见数据的表挂 AFTER INSERT / UPDATE / DELETE,在同一条语句里 upsert 这一行 —— 与写本身同一个隐式事务,写回滚它跟着回滚。

- **挂了的表**:`accounts`、`portfolios`、`tags`、`tab_pins`、`user_settings`(自带 `user_id`);`snapshots`(仅 INSERT/DELETE)、`account_tags`、`manual_activity`(经 `accounts` 查归属);`portfolio_accounts`(经 `portfolios` 查归属);`tokens`(仅用户能改的三列真变了时)。
- **刻意不挂的**与理由在 `packages/db/src/schema/app.ts` 的 `userDataVersion` 注释里;`tests/data-version.test.ts` 按 sqlite_master 数覆盖面,新加一张带归属列的表而没决定挂不挂,当场红。
- **生成源**:`packages/db/scripts/data-version-triggers.ts`(`pnpm --filter @folio/db db:triggers` 打印 SQL)。`tests/data-version-rebuild.test.ts` 钉住它与库里真实触发器逐字一致。

**为什么是触发器**:覆盖面由库保证,将来新加的写 op(包括直接走 drizzle 的批量写、级联删)不可能「忘了抬」;而逐 op 抬要改二十多处写路径,每处都是一个可能漏掉的点,漏了没有任何信号。

## 已知的坑:重建触发器引用到的表

drizzle-kit 改不少 SQLite 列(改约束、改主键列名)时生成「重建」:`CREATE __new_X → INSERT…SELECT → DROP X → ALTER TABLE __new_X RENAME TO X`。当 X 被任一触发器引用(挂在 X 上,或在触发器体里查 X)时:

1. **RENAME 失败**:现代 SQLite(`legacy_alter_table=OFF`)改名时重新解析全库触发器,别的表上还引用着已被删的 X 的触发器 → `error in trigger …: no such table: main.X`,整条迁移回滚、部署卡住。**已在本仓 D1 测试环境(Miniflare)复现**;生产 D1 未单独验证,同为现代 SQLite,按同样行为处理。
2. **DROP 静默带走 X 自己的触发器**,重建完版本号就不再为 X 抬 —— 没有报错。

受影响的表(`REBUILD_SENSITIVE_TABLES`):上面挂了触发器的所有表,加上被查询的 `accounts` / `portfolios`、每条触发器体里都有的 `user`(见下)、写入目标 `user_data_version`。

## 强制流程

写一条会重建(或删除)上述任一张表的迁移时:

1. `pnpm --filter @folio/db db:triggers`,把打印的 **drop 段贴在迁移最开头**(任何 `DROP TABLE` / `RENAME` 之前),**create 段贴在最末尾**。整批删、整批建,不去算哪几条受影响 —— 算错的代价是部署卡住。
2. `tests/data-version-rebuild.test.ts` 扫 `drizzle/*.sql`(经 `readD1Migrations`):0010 之后的迁移凡重建 / 删除敏感表而没在前面删光、后面建回全部触发器的,测试红。
3. 若是**改触发器本身**(加表、改条件):先改生成器,再写迁移(同样先删后建),两个测试会对着新库比。

## 为什么不是别的

- **让触发器不引用别的表**:`user` 的 `EXISTS` 守卫是删用户时级联删各表、触发器往回插版本行撞 `user_data_version` 外键的唯一解法(去掉外键 → 删了的用户留孤儿行);`snapshots` 等表没有 `user_id` 列,只能去父表查归属(要去掉就得给四张子表冗余 `user_id`,那是一次更大、更难回退的改动)。不比现在简单。
- **`PRAGMA legacy_alter_table = ON`**:Miniflare 上试过,能让 RENAME 过去;但生产 D1 是否放行未验证,而且解决不了第 2 条(本表自己的触发器被 DROP 带走),照样得建回。统一走先删后建。
- **逐 op 在 batch 里抬**:见上「为什么是触发器」。

## 代价

- 每次重建上述表的迁移多两段样板 SQL;漏了测试会拦,不会到 `db:migrate:remote` 才发现。
- 触发器对 drizzle-kit 不可见:它生成的 snapshot / diff 里没有这些对象,读 schema 的人得看 `userDataVersion` 那段注释或本 ADR。
