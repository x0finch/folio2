CREATE TABLE `token_index` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`token_id` text NOT NULL,
	`cgk_checked_until` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `key`, `token_id`),
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_index_kind_key_idx` ON `token_index` (`kind`,`key`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`logo` text,
	`provider_logo` text,
	`market_cap_rank` integer,
	`info_expires_at` integer NOT NULL,
	`unit_price` real,
	`change_24h` real,
	`price_as_of` integer,
	`price_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_source_identifier_idx` ON `tokens` (`source`,`identifier`);--> statement-breakpoint
DROP TABLE `token_contract`;--> statement-breakpoint
DROP TABLE `token_info`;--> statement-breakpoint
DROP TABLE `token_price`;--> statement-breakpoint
DROP TABLE `token_warm`;