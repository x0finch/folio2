CREATE TABLE `token_price_history` (
	`source` text NOT NULL,
	`cgk_id` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`unit_price` real NOT NULL,
	PRIMARY KEY(`source`, `cgk_id`, `day_bucket`)
);
