ALTER TABLE `token_vendor_ids` ADD `unit_price` real;--> statement-breakpoint
ALTER TABLE `token_vendor_ids` ADD `change_24h` real;--> statement-breakpoint
ALTER TABLE `token_vendor_ids` ADD `price_as_of` integer;--> statement-breakpoint
ALTER TABLE `token_vendor_ids` ADD `price_expires_at` integer;--> statement-breakpoint
UPDATE `token_vendor_ids` SET
  `unit_price` = (SELECT `t`.`unit_price` FROM `tokens` `t` WHERE `t`.`id` = `token_vendor_ids`.`token_id`),
  `change_24h` = (SELECT `t`.`change_24h` FROM `tokens` `t` WHERE `t`.`id` = `token_vendor_ids`.`token_id`),
  `price_as_of` = (SELECT `t`.`price_as_of` FROM `tokens` `t` WHERE `t`.`id` = `token_vendor_ids`.`token_id`),
  `price_expires_at` = (SELECT `t`.`price_expires_at` FROM `tokens` `t` WHERE `t`.`id` = `token_vendor_ids`.`token_id`)
WHERE `token_vendor_ids`.`vendor` = 'coingecko';--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `unit_price`;--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `change_24h`;--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `price_as_of`;--> statement-breakpoint
ALTER TABLE `tokens` DROP COLUMN `price_expires_at`;