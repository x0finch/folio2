ALTER TABLE `accounts` RENAME COLUMN "type" TO "connector_id";--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='evm' WHERE `connector_id`='onchain_evm';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='bitcoin' WHERE `connector_id`='onchain_bitcoin';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='solana' WHERE `connector_id`='onchain_solana';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='sui' WHERE `connector_id`='onchain_sui';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='cosmos' WHERE `connector_id`='onchain_cosmos';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='binance' WHERE `connector_id`='exchange_binance';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='okx' WHERE `connector_id`='exchange_okx';--> statement-breakpoint
UPDATE `accounts` SET `connector_id`='hyperliquid' WHERE `connector_id`='perp_hyperliquid';--> statement-breakpoint
UPDATE `accounts`
  SET `enc_credentials`=json_set(json_remove(`enc_credentials`,'$.identifier'),'$.address',json_extract(`enc_credentials`,'$.identifier'))
  WHERE `connector_id` IN ('evm','solana','sui','cosmos','hyperliquid')
    AND json_extract(`enc_credentials`,'$.identifier') IS NOT NULL;--> statement-breakpoint
UPDATE `accounts`
  SET `enc_credentials`=json_set(json_remove(`enc_credentials`,'$.identifier'),'$.addressOrXpub',json_extract(`enc_credentials`,'$.identifier'))
  WHERE `connector_id`='bitcoin'
    AND json_extract(`enc_credentials`,'$.identifier') IS NOT NULL;
