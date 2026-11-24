// Single source of the data-version triggers; tests/data-version-rebuild.test.ts diffs it against sqlite_master.
//
// Use when a migration rebuilds any REBUILD_SENSITIVE_TABLES table: SQLite's RENAME re-parses all triggers (failing on ones that reference the dropped table) and DROP TABLE silently drops its own.
// So paste the drop block at the top of the migration and the create block at the end, for all tables.
//
// Usage (in packages/db): pnpm db:triggers

type Event = "insert" | "update" | "delete";

// Table has its own user_id.
const OWN: ReadonlyArray<readonly [table: string, events: readonly Event[]]> = [
  ["accounts", ["insert", "update", "delete"]],
  ["portfolios", ["insert", "update", "delete"]],
  ["tags", ["insert", "update", "delete"]],
  ["tab_pins", ["insert", "update", "delete"]],
  ["user_settings", ["insert", "update", "delete"]],
];

// Table hangs off a user_id parent via FK: the trigger looks up ownership in the parent.
const VIA: ReadonlyArray<
  readonly [table: string, events: readonly Event[], parent: string, fk: string]
> = [
  // The only snapshot UPDATE is pruneNotes on old snapshots, which are off-screen.
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

// Tables referenced by triggers (attached to, or queried in a body). Rebuilding any needs the drop/create blocks. `user` is in every body (cascade EXISTS guard); `user_data_version` is the write target.
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
  // Bump only when one of the three user-editable columns really changed (price / info refreshes don't).
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
  console.log("-- (1) Paste at the very top of the migration (before any DROP TABLE / RENAME):");
  console.log(dropDataVersionTriggers().join(BREAK) + BREAK);
  console.log("-- (2) Paste at the very end of the migration (after all RENAMEs):");
  console.log(BREAK + createDataVersionTriggers().join(BREAK));
}
