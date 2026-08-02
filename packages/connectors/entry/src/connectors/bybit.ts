import { defineConnector, Spot } from "@folio/connectors-basic";
import { bybitAccountCreds, bybitProvider } from "@folio/connectors-provider-bybit";

// bybit connector manifest —— 组装契约(基座)+ provider(bybit)。secret 型 account.creds:
// apiKey/secret 由 app 分派桥加密入库、取数时 openCreds 解密后灌进 ctx.account.creds。**无 passphrase**
// (异于 OKX)。manifest 组装归 entry;account.creds 声明随 provider(其天然消费者)落 provider 包。
// logo:固定的 CoinGecko Bybit 交易所图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const BYBIT_LOGO = "https://assets.coingecko.com/markets/images/698/large/bybit_spot.png";

export const bybit = defineConnector({
  id: "bybit",
  label: "Bybit",
  logo: BYBIT_LOGO,
  account: { creds: bybitAccountCreds },
  // 本轮单 kind connector:schema 直接用 Spot(perp 缓做,见 ADR 0032)。perp 片落地时升 Spot | PerpPosition。
  balance: { schema: Spot, providers: [bybitProvider] },
});
