CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`per_usd` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`price_usd` real NOT NULL,
	`change_24h` real,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`dust_usd` real NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
