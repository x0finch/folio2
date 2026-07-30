PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`logo` text,
	`provider_logo` text,
	`market_cap_rank` integer,
	`info_expires_at` integer NOT NULL,
	`unit_price` real,
	`change_24h` real,
	`price_as_of` integer,
	`price_expires_at` integer,
	`self_price` real,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tokens`("id", "user_id", "symbol", "name", "logo", "provider_logo", "market_cap_rank", "info_expires_at", "unit_price", "change_24h", "price_as_of", "price_expires_at", "self_price") SELECT "id", "user_id", "symbol", "name", "logo", "provider_logo", "market_cap_rank", "info_expires_at", "unit_price", "change_24h", "price_as_of", "price_expires_at", "self_price" FROM `tokens`;--> statement-breakpoint
DROP TABLE `tokens`;--> statement-breakpoint
ALTER TABLE `__new_tokens` RENAME TO `tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;