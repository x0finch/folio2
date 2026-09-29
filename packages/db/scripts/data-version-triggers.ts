// 数据版本号触发器(FOL-94,ADR 0057)的**唯一生成源**。迁移 0010 里那批 CREATE TRIGGER 与这里
// 逐字相同 —— `tests/data-version-rebuild.test.ts` 拿它对 sqlite_master 比,漂了当场红。
//
// 什么时候要用:一条迁移要**重建**(drizzle 的 `__new_X` 四步)`REBUILD_SENSITIVE_TABLES` 里任一张表。
// SQLite 的 RENAME 会重新解析全库触发器,还在引用被删表的触发器让它直接失败;DROP TABLE 又会静默
// 带走本表自己的触发器。所以:迁移**开头**贴 drop 段,**末尾**贴 create 段(整批都删、整批都建,
// 不去算哪几条受影响 —— 算错的代价是部署卡住)。
//
// 用法(在 packages/db 下):pnpm db:triggers   → 打印两段 SQL,照注释贴进迁移。
// 纯 TS、无 import,Node 22.18+ 的类型擦除直接能跑。

type Event = "insert" | "update" | "delete";

// 表本身带 user_id。
const OWN: ReadonlyArray<readonly [table: string, events: readonly Event[]]> = [
  ["accounts", ["insert", "update", "delete"]],
  ["portfolios", ["insert", "update", "delete"]],
  ["tags", ["insert", "update", "delete"]],
  ["tab_pins", ["insert", "update", "delete"]],
  ["user_settings", ["insert", "update", "delete"]],
];

// 表经外键挂在某个带 user_id 的父表下:触发器得去父表查归属(这就是跨表引用的来源)。
const VIA: ReadonlyArray<
  readonly [table: string, events: readonly Event[], parent: string, fk: string]
> = [
  // 快照唯一的 UPDATE 是清旧快照的 note(pruneNotes),那几张早就不在屏幕上了。
  ["snapshots", ["insert", "delete"], "accounts", "account_id"],
  ["account_tags", ["insert", "update", "delete"], "accounts", "account_id"],
  ["manual_activity", ["insert", "update", "delete"], "accounts", "account_id"],
  ["portfolio_accounts", ["insert", "update", "delete"], "portfolios", "portfolio_id"],
];

const UPSERT_TAIL =
  "\tON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;\nEND;";
const INSERT_HEAD = "\tINSERT INTO `user_data_version` (`user_id`, `version`)\n";
const rowOf = (e: Event) => (e === "delete" ? "OLD" : "NEW");
const nameOf = (table: string, e: Event) => `${table}_data_version_${e}`;
const head = (table: string, e: Event) =>
  `CREATE TRIGGER \`${nameOf(table, e)}\` AFTER ${e.toUpperCase()} ON \`${table}\` FOR EACH ROW BEGIN\n`;

// 被触发器**引用**(挂在其上,或在触发器体里被查)的表。重建其中任一张 → 走上面那套 drop / create。
// `user` 在每条触发器体里(删用户级联时的 EXISTS 守卫);`user_data_version` 是写入目标。
export const REBUILD_SENSITIVE_TABLES: readonly string[] = [
  ...new Set([
    ...OWN.map(([t]) => t),
    ...VIA.flatMap(([t, , parent]) => [t, parent]),
    "tokens",
    "user",
    "user_data_version",
  ]),
];

export function createDataVersionTriggers(): string[] {
  const own = OWN.flatMap(([table, events]) =>
    events.map(
      (e) =>
        head(table, e) +
        INSERT_HEAD +
        `\tSELECT ${rowOf(e)}.\`user_id\`, 1 WHERE EXISTS (SELECT 1 FROM \`user\` WHERE \`id\` = ${rowOf(e)}.\`user_id\`)\n` +
        UPSERT_TAIL,
    ),
  );
  const via = VIA.flatMap(([table, events, parent, fk]) =>
    events.map(
      (e) =>
        head(table, e) +
        INSERT_HEAD +
        `\tSELECT p.\`user_id\`, 1 FROM \`${parent}\` p WHERE p.\`id\` = ${rowOf(e)}.\`${fk}\` AND EXISTS (SELECT 1 FROM \`user\` WHERE \`id\` = p.\`user_id\`)\n` +
        UPSERT_TAIL,
    ),
  );
  // 只在用户能改的三列**真的变了**时抬(价格 / 信息刷新不抬)。
  const tokens =
    "CREATE TRIGGER `tokens_data_version_update` AFTER UPDATE OF `symbol`, `name`, `self_price` ON `tokens` FOR EACH ROW\n" +
    "\tWHEN OLD.`symbol` IS NOT NEW.`symbol` OR OLD.`name` IS NOT NEW.`name` OR OLD.`self_price` IS NOT NEW.`self_price`\n" +
    "BEGIN\n" +
    INSERT_HEAD +
    "\tSELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)\n" +
    UPSERT_TAIL;
  return [...own, ...via, tokens];
}

export function dropDataVersionTriggers(): string[] {
  return createDataVersionTriggers().map((sql) => {
    const name = /^CREATE TRIGGER `([^`]+)`/.exec(sql)?.[1];
    return `DROP TRIGGER IF EXISTS \`${name}\`;`;
  });
}

const BREAK = "\n--> statement-breakpoint\n";

if ((import.meta as { main?: boolean }).main) {
  console.log("-- ① 贴在迁移最开头(任何 DROP TABLE / RENAME 之前):");
  console.log(dropDataVersionTriggers().join(BREAK) + BREAK);
  console.log("-- ② 贴在迁移最末尾(所有 RENAME 之后):");
  console.log(BREAK + createDataVersionTriggers().join(BREAK));
}
