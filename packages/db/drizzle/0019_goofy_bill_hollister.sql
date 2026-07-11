ALTER TABLE `manual_activity` RENAME COLUMN "note" TO "memo";--> statement-breakpoint
ALTER TABLE `snapshot_balances` ADD `note` text;--> statement-breakpoint
ALTER TABLE `snapshot_balances` DROP COLUMN `detail`;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `note` text;