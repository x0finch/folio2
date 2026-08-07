import { defineConnector, Spot } from "@folio/connectors-basic";
import { bitcoinAccountCreds, blockbookProvider } from "./provider";

// bitcoin connector manifest —— 组装契约(基座)+ 适配层。
// 适配层住在这个目录(ADR 0036),请求那一半在 `@folio/blockbook-client`(四节点轮换 = 它的重试)。
// logo:固定的 CoinGecko BTC 图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const BTC_LOGO = "https://assets.coingecko.com/coins/images/1/large/bitcoin.png";

export const bitcoin = defineConnector({
  id: "bitcoin",
  label: "Bitcoin",
  logo: BTC_LOGO,
  account: { creds: bitcoinAccountCreds },
  // 单 kind connector:BTC 并回 spot(ADR 0010),schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [blockbookProvider] },
  // 无权威价:provider 只产已确认 amount(value=0),恒按 BTC 市价盯市。
  valuation: "mark-to-market",
});
