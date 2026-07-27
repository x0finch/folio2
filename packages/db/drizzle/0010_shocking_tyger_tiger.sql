CREATE TABLE `global_token_ref_index` (
	`ref` text NOT NULL,
	`namer` text NOT NULL,
	`local_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`ref`, `namer`)
);
--> statement-breakpoint
CREATE TABLE `token_daily_prices` (
	`token_ref` text NOT NULL,
	`day_bucket` integer NOT NULL,
	`unit_price` real NOT NULL,
	PRIMARY KEY(`token_ref`, `day_bucket`)
);
--> statement-breakpoint
CREATE TABLE `token_refs` (
	`user_id` text NOT NULL,
	`namer` text NOT NULL,
	`local_name` text NOT NULL,
	`token_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `namer`, `local_name`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_refs_token_id_namer_idx` ON `token_refs` (`token_id`,`namer`);--> statement-breakpoint
CREATE TABLE `user_cache` (
	`user_id` text NOT NULL,
	`k` text NOT NULL,
	`v` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `k`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `snapshot_balances` ADD `token_id` text;--> statement-breakpoint
-- 手改一处:`ON DELETE cascade` 是 schema.ts 声明的(snapshot json 里也记着),但 drizzle-kit 的
-- ADD COLUMN 代码路径不发 FK 动作,只发裸 REFERENCES。缺了它就是 NO ACTION —— 删用户会撞外键
-- 而不是级联清理(packages/db 的测试 teardown 正是直接删 user)。SQLite 允许 ADD COLUMN 带
-- REFERENCES + 动作,前提是默认值为 NULL(此处正是),故补上即与 schema 一致。
ALTER TABLE `tokens` ADD `user_id` text REFERENCES user(id) ON DELETE cascade;