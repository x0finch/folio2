CREATE TABLE `account_tags` (
	`tag_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `account_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_tags_account_id_idx` ON `account_tags` (`account_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tags_user_id_idx` ON `tags` (`user_id`);--> statement-breakpoint
CREATE INDEX `tags_portfolio_id_idx` ON `tags` (`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_portfolio_name_uidx` ON `tags` (`user_id`,`portfolio_id`,lower("name"));