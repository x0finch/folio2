-- 一次性数据迁移(ADR 0020):代币标识统一为 tokenRef `<namer>/<localName>`,链命名者改短形。
-- 无 schema 变更,只重写既有串。三条规则(与 @folio/oracle-ref 的规范形一一对应):
--   chain:<slug>/native:<sym>  →  <slug>/native      (尾巴的 symbol 从来没被读出来过)
--   chain:<slug>/token:<addr>  →  <slug>/token:<addr>
--   coingecko:<id>             →  coingecko/<id>
-- EVM 规范形 `eip155:<chainId>/erc20:<addr>` 本就合规,不匹配任何一条 → 原样不动。
-- 幂等:新形不带 `chain:` 前缀、也不是无斜杠的 `coingecko:`,重跑即 no-op。

-- 1) 链命名者去掉 `chain:` 前缀。
UPDATE `snapshot_balances`
SET `token_key` = substr(`token_key`, length('chain:') + 1)
WHERE `token_key` LIKE 'chain:%';

-- 2) 原生币丢掉装饰性的 symbol 尾巴(`…/native:btc` → `…/native`)。
UPDATE `snapshot_balances`
SET `token_key` = substr(`token_key`, 1, instr(`token_key`, '/native:') + length('/native') - 1)
WHERE `token_key` LIKE '%/native:%';

-- 3) 旧 refKey 形(无斜杠)补上斜杠。
UPDATE `snapshot_balances`
SET `token_key` = 'coingecko/' || substr(`token_key`, length('coingecko:') + 1)
WHERE `token_key` LIKE 'coingecko:%';

-- 4) 代币索引是带 TTL 的纯缓存,旧形键清掉自会按新形重建(不能就地改:主键含 key)。
DELETE FROM `token_index` WHERE `kind` = 'tokenKey';

-- 5) 平台元数据同为纯缓存(name+logo 来自 CoinGecko,带 expires_at)。
--    链键随本次迁短形(`chain:bitcoin` → `bitcoin`),清表后由 warm 自行重建。
DELETE FROM `platforms`;
