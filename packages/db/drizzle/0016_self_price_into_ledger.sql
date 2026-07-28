-- 手记的「这个币值多少」收成**一个来源:账本**。
--
-- 原来有两处:`tokens.self_price`(加账户表单直接写)与每笔 `manual_activity.price`。同一件事两处存,
-- 其中一处可以存歪 —— 实测有代币的 self_price 停在 0、后面记多少笔活动都盖不掉,列表里一行没有价。
-- 代码侧已经没有写者(开仓价改为写进开仓那笔 set 活动),这里把存量搬过去。
--
-- 搬法:每个 token 最早那笔活动就是它的开仓 —— 若它没记价,就把 self_price 补上去。
-- 已经记了价的活动一律不动(账本是事实,迁移不改事实)。
UPDATE manual_activity
SET price = (SELECT t.self_price FROM tokens t WHERE t.id = manual_activity.token_id)
WHERE price IS NULL
  AND token_id IN (SELECT id FROM tokens WHERE self_price IS NOT NULL AND self_price > 0)
  AND id = (
    SELECT a2.id FROM manual_activity a2
    WHERE a2.token_id = manual_activity.token_id
    ORDER BY a2.occurred_at ASC, a2.created_at ASC
    LIMIT 1
  );
--> statement-breakpoint
-- 列留着(删列要重建表,而它下一轮 #202 还会碰这张表),但清空 —— 免得留一份没人读、
-- 又和账本对不上的影子数据。
UPDATE tokens SET self_price = NULL WHERE self_price IS NOT NULL;
