CREATE TABLE `manual_holding` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`unit_price` real NOT NULL,
	`identifier` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_holding_account_id_idx` ON `manual_holding` (`account_id`);--> statement-breakpoint
ALTER TABLE `manual_activity` ADD `holding_id` text REFERENCES manual_holding(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `manual_activity_holding_id_occurred_at_idx` ON `manual_activity` (`holding_id`,`occurred_at`);