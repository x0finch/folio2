PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_snapshot_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`amount` real NOT NULL,
	`usd_value` real NOT NULL,
	`kind` text NOT NULL,
	`self_price` real,
	`platform` text,
	`token_id` text NOT NULL,
	`meta_json` text,
	`note` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_snapshot_balances`("id", "snapshot_id", "amount", "usd_value", "kind", "self_price", "platform", "token_id", "meta_json", "note") SELECT "id", "snapshot_id", "amount", "usd_value", "kind", "self_price", "platform", "token_id", "meta_json", "note" FROM `snapshot_balances`;--> statement-breakpoint
DROP TABLE `snapshot_balances`;--> statement-breakpoint
ALTER TABLE `__new_snapshot_balances` RENAME TO `snapshot_balances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `snapshot_balances_snapshot_id_idx` ON `snapshot_balances` (`snapshot_id`);