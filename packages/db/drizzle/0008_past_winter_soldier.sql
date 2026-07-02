ALTER TABLE `token_contract` RENAME COLUMN "coin_id" TO "identifier";--> statement-breakpoint
ALTER TABLE `token_info` RENAME COLUMN "coin_id" TO "identifier";--> statement-breakpoint
ALTER TABLE `token_price` RENAME COLUMN "coin_id" TO "identifier";--> statement-breakpoint
ALTER TABLE `token_warm` RENAME COLUMN "coin_id" TO "identifier";
