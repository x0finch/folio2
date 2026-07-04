CREATE TABLE `token_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`display_symbol` text NOT NULL,
	`name` text NOT NULL,
	`logo` text
);
--> statement-breakpoint
ALTER TABLE `tokens` ADD `group_id` text REFERENCES token_groups(id);