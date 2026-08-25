-- 存量库里可能已经有同名的 Portfolio(这条规则今天才有)。**先给重复的那些改名**:
-- 否则下面建唯一索引会直接失败,而一次失败的迁移会卡住整个部署。
--
-- 每组里最早建的那个留原名,后来的补一段 id 片段。用 id 而不是序号(「(2)」「(3)」)是因为
-- 序号可能撞上一个本来就叫「长期投资 (2)」的行 —— 那就又是一次失败的迁移。
UPDATE portfolios
SET name = trim(name) || ' (' || substr(id, 1, 8) || ')'
WHERE id IN (
	SELECT id FROM (
		SELECT id, ROW_NUMBER() OVER (
			PARTITION BY user_id, lower(trim(name)) ORDER BY created_at, id
		) AS seq
		FROM portfolios
	) WHERE seq > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_user_name_uidx` ON `portfolios` (`user_id`,lower(trim("name")));
