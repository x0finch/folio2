CREATE TABLE `user_data_version` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER `accounts_data_version_insert` AFTER INSERT ON `accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `accounts_data_version_update` AFTER UPDATE ON `accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `accounts_data_version_delete` AFTER DELETE ON `accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT OLD.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolios_data_version_insert` AFTER INSERT ON `portfolios` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolios_data_version_update` AFTER UPDATE ON `portfolios` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolios_data_version_delete` AFTER DELETE ON `portfolios` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT OLD.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tags_data_version_insert` AFTER INSERT ON `tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tags_data_version_update` AFTER UPDATE ON `tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tags_data_version_delete` AFTER DELETE ON `tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT OLD.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tab_pins_data_version_insert` AFTER INSERT ON `tab_pins` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tab_pins_data_version_update` AFTER UPDATE ON `tab_pins` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tab_pins_data_version_delete` AFTER DELETE ON `tab_pins` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT OLD.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `user_settings_data_version_insert` AFTER INSERT ON `user_settings` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `user_settings_data_version_update` AFTER UPDATE ON `user_settings` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `user_settings_data_version_delete` AFTER DELETE ON `user_settings` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT OLD.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `snapshots_data_version_insert` AFTER INSERT ON `snapshots` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = NEW.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `snapshots_data_version_delete` AFTER DELETE ON `snapshots` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = OLD.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `account_tags_data_version_insert` AFTER INSERT ON `account_tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = NEW.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `account_tags_data_version_update` AFTER UPDATE ON `account_tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = NEW.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `account_tags_data_version_delete` AFTER DELETE ON `account_tags` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = OLD.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `manual_activity_data_version_insert` AFTER INSERT ON `manual_activity` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = NEW.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `manual_activity_data_version_update` AFTER UPDATE ON `manual_activity` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = NEW.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `manual_activity_data_version_delete` AFTER DELETE ON `manual_activity` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `accounts` p WHERE p.`id` = OLD.`account_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolio_accounts_data_version_insert` AFTER INSERT ON `portfolio_accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `portfolios` p WHERE p.`id` = NEW.`portfolio_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolio_accounts_data_version_update` AFTER UPDATE ON `portfolio_accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `portfolios` p WHERE p.`id` = NEW.`portfolio_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `portfolio_accounts_data_version_delete` AFTER DELETE ON `portfolio_accounts` FOR EACH ROW BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT p.`user_id`, 1 FROM `portfolios` p WHERE p.`id` = OLD.`portfolio_id` AND EXISTS (SELECT 1 FROM `user` WHERE `id` = p.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tokens_data_version_update` AFTER UPDATE OF `symbol`, `name`, `self_price` ON `tokens` FOR EACH ROW
	WHEN OLD.`symbol` IS NOT NEW.`symbol` OR OLD.`name` IS NOT NEW.`name` OR OLD.`self_price` IS NOT NEW.`self_price`
BEGIN
	INSERT INTO `user_data_version` (`user_id`, `version`)
	SELECT NEW.`user_id`, 1 WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = NEW.`user_id`)
	ON CONFLICT(`user_id`) DO UPDATE SET `version` = `user_data_version`.`version` + 1;
END;
