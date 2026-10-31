CREATE TABLE `asset_snapshots` (
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`asset_id` text NOT NULL,
	`amount` text NOT NULL,
	`value_usd` real,
	PRIMARY KEY(`user_id`, `asset_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`user_id` text NOT NULL,
	`hour` integer NOT NULL,
	`total_usd` real NOT NULL,
	PRIMARY KEY(`user_id`, `hour`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
