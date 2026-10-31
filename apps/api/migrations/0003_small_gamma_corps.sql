CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text,
	`logo` text,
	`amount` text NOT NULL,
	`kind` text NOT NULL,
	`location` text,
	`price_usd` real,
	`value_usd` real,
	`perp` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `positions_user_idx` ON `positions` (`user_id`);--> statement-breakpoint
CREATE INDEX `positions_connection_idx` ON `positions` (`connection_id`);