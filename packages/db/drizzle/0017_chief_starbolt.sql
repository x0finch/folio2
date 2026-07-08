CREATE TABLE `provider_config` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`account_type` text NOT NULL,
	`enabled` integer,
	`settings` text
);
