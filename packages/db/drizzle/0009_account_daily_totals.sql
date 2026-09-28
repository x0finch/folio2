CREATE TABLE `account_daily_totals` (
	`account_id` text NOT NULL,
	`day` integer NOT NULL,
	`open_usd` real NOT NULL,
	`open_at` integer NOT NULL,
	`min_usd` real NOT NULL,
	`min_at` integer NOT NULL,
	`max_usd` real NOT NULL,
	`max_at` integer NOT NULL,
	`close_usd` real NOT NULL,
	`close_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `day`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- FOL-91 backfill (hand-written): roll every existing snapshot up into one row per account per
-- UTC day. Tie-breaks match the write path (SnapshotStore.write): open = earliest taken_at,
-- close = latest (rowid breaks ties, the later write wins), min/max = extreme total_usd with the
-- earliest taken_at on ties. OR REPLACE keeps it re-runnable; the table is empty at migrate time.
INSERT OR REPLACE INTO `account_daily_totals` (`account_id`, `day`, `open_usd`, `open_at`, `min_usd`, `min_at`, `max_usd`, `max_at`, `close_usd`, `close_at`)
SELECT
	`account_id`,
	`day`,
	MAX(CASE WHEN `o` = 1 THEN `total_usd` END),
	MAX(CASE WHEN `o` = 1 THEN `taken_at` END),
	MAX(CASE WHEN `mn` = 1 THEN `total_usd` END),
	MAX(CASE WHEN `mn` = 1 THEN `taken_at` END),
	MAX(CASE WHEN `mx` = 1 THEN `total_usd` END),
	MAX(CASE WHEN `mx` = 1 THEN `taken_at` END),
	MAX(CASE WHEN `c` = 1 THEN `total_usd` END),
	MAX(CASE WHEN `c` = 1 THEN `taken_at` END)
FROM (
	SELECT
		`account_id`,
		`day`,
		`taken_at`,
		`total_usd`,
		ROW_NUMBER() OVER (PARTITION BY `account_id`, `day` ORDER BY `taken_at` ASC, `rid` ASC) AS `o`,
		ROW_NUMBER() OVER (PARTITION BY `account_id`, `day` ORDER BY `total_usd` ASC, `taken_at` ASC, `rid` ASC) AS `mn`,
		ROW_NUMBER() OVER (PARTITION BY `account_id`, `day` ORDER BY `total_usd` DESC, `taken_at` ASC, `rid` ASC) AS `mx`,
		ROW_NUMBER() OVER (PARTITION BY `account_id`, `day` ORDER BY `taken_at` DESC, `rid` DESC) AS `c`
	FROM (
		SELECT
			`account_id`,
			CAST(`taken_at` / 86400000 AS INTEGER) * 86400000 AS `day`,
			`taken_at`,
			`total_usd`,
			`rowid` AS `rid`
		FROM `snapshots`
	)
)
GROUP BY `account_id`, `day`;
