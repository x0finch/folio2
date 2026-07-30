DROP INDEX `token_refs_token_id_namer_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `token_refs_token_id_namer_uidx` ON `token_refs` (`user_id`,`token_id`,`namer`);