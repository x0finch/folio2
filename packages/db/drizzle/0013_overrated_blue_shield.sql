DROP TABLE `manual_token`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_manual_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_id` text,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`price` real,
	`fee` real,
	`occurred_at` integer NOT NULL,
	`memo` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_manual_activity`("id", "account_id", "token_id", "kind", "amount", "price", "fee", "occurred_at", "memo", "created_at") SELECT "id", "account_id", "token_id", "kind", "amount", "price", "fee", "occurred_at", "memo", "created_at" FROM `manual_activity`;--> statement-breakpoint
DROP TABLE `manual_activity`;--> statement-breakpoint
ALTER TABLE `__new_manual_activity` RENAME TO `manual_activity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `manual_activity_account_id_occurred_at_idx` ON `manual_activity` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `manual_activity_token_id_occurred_at_idx` ON `manual_activity` (`token_id`,`occurred_at`);