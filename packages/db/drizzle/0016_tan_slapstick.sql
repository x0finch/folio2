CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`usd_per_unit` real NOT NULL,
	`expires_at` integer NOT NULL
);
