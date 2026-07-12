CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_vendor` text DEFAULT 'coingecko' NOT NULL,
	`valuation_mode` text DEFAULT 'self-first' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
