CREATE TABLE `token_vendor_ids` (
	`token_id` text NOT NULL,
	`vendor` text NOT NULL,
	`vendor_id` text NOT NULL,
	PRIMARY KEY(`vendor`, `vendor_id`),
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_vendor_ids_token_idx` ON `token_vendor_ids` (`token_id`);--> statement-breakpoint
INSERT INTO `token_vendor_ids` (`token_id`, `vendor`, `vendor_id`) SELECT `id`, `source`, `identifier` FROM `tokens` WHERE `source` = 'coingecko';--> statement-breakpoint
DROP INDEX `tokens_source_identifier_idx`;--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `source`;--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `identifier`;