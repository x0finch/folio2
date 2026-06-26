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
	`type` text NOT NULL,
	`network` text,
	`label` text NOT NULL,
	`enc_credentials` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `groups_user_id_idx` ON `groups` (`user_id`);--> statement-breakpoint
CREATE TABLE `snapshot_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`symbol` text NOT NULL,
	`amount` real NOT NULL,
	`usd_value` real NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`meta_json` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_balances_snapshot_id_idx` ON `snapshot_balances` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`total_usd` real NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_account_id_idx` ON `snapshots` (`account_id`);