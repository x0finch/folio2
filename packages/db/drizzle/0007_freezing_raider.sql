-- 词汇统一(ADR 0020):代币标识全站叫 tokenRef,列名与索引 kind 跟上。
-- 值的文法在 0006 已迁完,这里只改名字。
ALTER TABLE `snapshot_balances` RENAME COLUMN "token_key" TO "token_ref";
--> statement-breakpoint
-- token_index.kind 的字面量随之更名。该表是带 TTL 的纯缓存,直接改值即可(不改也会自愈,但留着旧值会读不到)。
UPDATE `token_index` SET `kind` = 'tokenRef' WHERE `kind` = 'tokenKey';
