-- 一次性数据清理(ADR 0018 / #154 T2):manual 账户退出 snapshot 模型,当下值改由 creds.tokens 现造。
-- 删除既有 manual 账户的快照行(snapshot_balances 经 ON DELETE cascade 一并删)。真相是账本 manual_activity,
-- 快照仅其派生值 → 非数据丢失;历史由 T5(compute-on-read)从账本重算。幂等:无匹配即 no-op。
DELETE FROM `snapshots` WHERE `account_id` IN (SELECT `id` FROM `accounts` WHERE `connector_id` = 'manual');
