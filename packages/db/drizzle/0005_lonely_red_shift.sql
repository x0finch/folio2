CREATE TABLE `token_price_history` (
	`source` text NOT NULL,
	`identifier` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`unit_price` real NOT NULL,
	PRIMARY KEY(`source`, `identifier`, `day_bucket`)
);
