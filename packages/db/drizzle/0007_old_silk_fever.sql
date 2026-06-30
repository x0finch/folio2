CREATE TABLE `manual_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`price` real,
	`occurred_at` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_activity_account_id_occurred_at_idx` ON `manual_activity` (`account_id`,`occurred_at`);