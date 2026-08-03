CREATE TABLE `portfolio_accounts` (
	`portfolio_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`portfolio_id`, `account_id`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_accounts_account_uidx` ON `portfolio_accounts` (`account_id`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portfolios_user_id_idx` ON `portfolios` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_user_default_uidx` ON `portfolios` (`user_id`) WHERE "portfolios"."is_default" = 1;--> statement-breakpoint
-- 存量数据迁移(ADR 0033):给每个现有用户 seed 一行默认 Portfolio,名字 = `<用户名>'s Portfolio`
-- (名为空兜底 `My Portfolio`)——**与 queries.ts 的 defaultPortfolioName 保持一致**。
-- id 用 lower(hex(randomblob(16)))(id 列是 TEXT、不强制 UUID 格式);createdAt 用当前 epoch ms。
INSERT INTO `portfolios` (`id`, `user_id`, `name`, `is_default`, `sort_order`, `created_at`)
SELECT lower(hex(randomblob(16))), `u`.`id`,
  CASE WHEN trim(coalesce(`u`.`name`, '')) <> ''
    THEN trim(`u`.`name`) || '''s'
    ELSE 'My Portfolio' END,
  1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `user` `u`;--> statement-breakpoint
-- backfill:每个现有账户归属到其用户的默认 Portfolio(一对一,恰一行)。
INSERT INTO `portfolio_accounts` (`portfolio_id`, `account_id`)
SELECT `p`.`id`, `a`.`id`
FROM `accounts` `a`
JOIN `portfolios` `p` ON `p`.`user_id` = `a`.`user_id` AND `p`.`is_default` = 1;