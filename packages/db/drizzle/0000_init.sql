CREATE TABLE `account_groups` (
	`account_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `group_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_groups_group_id_idx` ON `account_groups` (`group_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`platform` text,
	`label` text NOT NULL,
	`enc_credentials` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `global_token_ref_index` (
	`ref` text NOT NULL,
	`namer` text NOT NULL,
	`local_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`ref`, `namer`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `groups_user_id_idx` ON `groups` (`user_id`);--> statement-breakpoint
CREATE TABLE `manual_activity` (
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
CREATE INDEX `manual_activity_account_id_occurred_at_idx` ON `manual_activity` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `manual_activity_token_id_occurred_at_idx` ON `manual_activity` (`token_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `snapshot_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`symbol` text NOT NULL,
	`amount` real NOT NULL,
	`usd_value` real NOT NULL,
	`kind` text NOT NULL,
	`self_price` real,
	`token_ref` text,
	`platform` text,
	`token_id` text,
	`meta_json` text,
	`note` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_balances_snapshot_id_idx` ON `snapshot_balances` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`total_usd` real NOT NULL,
	`note` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_account_id_idx` ON `snapshots` (`account_id`);--> statement-breakpoint
CREATE INDEX `snapshots_account_id_taken_at_idx` ON `snapshots` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `token_daily_prices` (
	`token_ref` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`unit_price` real NOT NULL,
	PRIMARY KEY(`token_ref`, `day_bucket`)
);
--> statement-breakpoint
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
CREATE TABLE `token_meta` (
	`k` text PRIMARY KEY NOT NULL,
	`v` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_price_history` (
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`unit_price` real NOT NULL,
	PRIMARY KEY(`source`, `identifier`, `day_bucket`)
);
--> statement-breakpoint
CREATE TABLE `token_refs` (
	`user_id` text NOT NULL,
	`namer` text NOT NULL,
	`local_name` text NOT NULL,
	`token_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `namer`, `local_name`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_refs_token_id_namer_idx` ON `token_refs` (`token_id`,`namer`);--> statement-breakpoint
CREATE TABLE `token_vendor_ids` (
	`token_id` text NOT NULL,
	`vendor` text NOT NULL,
	`vendor_id` text NOT NULL,
	PRIMARY KEY(`vendor`, `vendor_id`),
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_vendor_ids_token_idx` ON `token_vendor_ids` (`token_id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
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
CREATE TABLE `user_cache` (
	`user_id` text NOT NULL,
	`k` text NOT NULL,
	`v` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `k`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`valuation_mode` text DEFAULT 'self-first' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
