CREATE TABLE `manual_token` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`unit_price` real NOT NULL,
	`identifier` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_token_account_id_idx` ON `manual_token` (`account_id`);--> statement-breakpoint
ALTER TABLE `manual_activity` ADD `token_id` text REFERENCES manual_token(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `manual_activity_token_id_occurred_at_idx` ON `manual_activity` (`token_id`,`occurred_at`);