CREATE TABLE `snapshot_notes` (
	`user_id` text NOT NULL,
	`hash` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`user_id`, `hash`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `snapshots` ADD `note_hash` text;