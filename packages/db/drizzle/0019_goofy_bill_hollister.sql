ALTER TABLE `manual_activity` RENAME COLUMN "note" TO "memo";--> statement-breakpoint
ALTER TABLE `snapshots` ADD `note` text;