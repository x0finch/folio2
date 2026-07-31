DROP TABLE `global_token_ref_index`;
--> statement-breakpoint
CREATE TABLE `global_token_ref_index` (
	`chain_ref` text NOT NULL,
	`upstream` text NOT NULL,
	`upstream_local_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`chain_ref`, `upstream`)
);
