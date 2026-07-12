import { defineConnector, Utxo } from "@folio/connectors-basic";
import { bitcoinAccountCreds, blockbookProvider } from "@folio/connectors-provider-blockbook";

// bitcoin connector manifest —— 组装契约(基座)+ provider(blockbook)。manifest 组装归 entry;
// account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
// logo:固定的 CoinGecko BTC 图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const BTC_LOGO = "https://assets.coingecko.com/coins/images/1/large/bitcoin.png";

export const bitcoin = defineConnector({
  id: "bitcoin",
  label: "Bitcoin",
  logo: BTC_LOGO,
  account: { creds: bitcoinAccountCreds },
  // 单 kind connector:schema 直接用 Utxo(无需判别联合)。
  balance: { schema: Utxo, providers: [blockbookProvider] },
  // 无权威价:provider 只产已确认 amount(value=0),恒按 BTC 市价盯市。
  valuation: "mark-to-market",
});
