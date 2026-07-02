ALTER TABLE `token_contract` RENAME COLUMN "coin_id" TO "identifier";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_token_info` (
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`logo` text,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`source`, `identifier`)
);
--> statement-breakpoint
INSERT INTO `__new_token_info`("source", "identifier", "symbol", "name", "logo", "expires_at") SELECT "source", "identifier", "symbol", "name", "logo", "expires_at" FROM `token_info`;--> statement-breakpoint
DROP TABLE `token_info`;--> statement-breakpoint
ALTER TABLE `__new_token_info` RENAME TO `token_info`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_token_price` (
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`unit_price` real NOT NULL,
	`change_24h` real,
	`market_cap_rank` integer,
	`as_of` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`source`, `identifier`)
);
--> statement-breakpoint
INSERT INTO `__new_token_price`("source", "identifier", "unit_price", "change_24h", "market_cap_rank", "as_of", "expires_at") SELECT "source", "identifier", "unit_price", "change_24h", "market_cap_rank", "as_of", "expires_at" FROM `token_price`;--> statement-breakpoint
DROP TABLE `token_price`;--> statement-breakpoint
ALTER TABLE `__new_token_price` RENAME TO `token_price`;--> statement-breakpoint
CREATE TABLE `__new_token_warm` (
	`symbol` text NOT NULL,
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`market_cap_rank` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`symbol`, `source`, `identifier`)
);
--> statement-breakpoint
INSERT INTO `__new_token_warm`("symbol", "source", "identifier", "market_cap_rank", "expires_at") SELECT "symbol", "source", "identifier", "market_cap_rank", "expires_at" FROM `token_warm`;--> statement-breakpoint
DROP TABLE `token_warm`;--> statement-breakpoint
ALTER TABLE `__new_token_warm` RENAME TO `token_warm`;