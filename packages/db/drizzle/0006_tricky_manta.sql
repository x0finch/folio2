CREATE TABLE `token_contract` (
	`source` text NOT NULL,
	`chain` text NOT NULL,
	`contract` text NOT NULL,
	`coin_id` text,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`source`, `chain`, `contract`)
);
--> statement-breakpoint
CREATE TABLE `token_info` (
	`source` text NOT NULL,
	`coin_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`logo` text,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`source`, `coin_id`)
);
--> statement-breakpoint
CREATE TABLE `token_meta` (
	`k` text PRIMARY KEY NOT NULL,
	`v` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_price` (
	`source` text NOT NULL,
	`coin_id` text NOT NULL,
	`unit_price` real NOT NULL,
	`change_24h` real,
	`market_cap_rank` integer,
	`as_of` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`source`, `coin_id`)
);
--> statement-breakpoint
CREATE TABLE `token_warm` (
	`symbol` text NOT NULL,
	`source` text NOT NULL,
	`coin_id` text NOT NULL,
	`market_cap_rank` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`symbol`, `source`, `coin_id`)
);
