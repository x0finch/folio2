import { defineConnector, Spot } from "@folio/connectors-basic";
import { binanceAccountCreds, binanceProvider } from "@folio/connectors-provider-binance";

// binance connector manifest —— 组装契约(基座)+ provider(binance)。首个带 secret 型 account.creds
// 的 connector:apiKey/secret 由 app 分派桥加密入库、取数时 openCreds 解密后灌进 ctx.account.creds。
// manifest 组装归 entry;account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
// logo:固定的 CoinGecko Binance 交易所图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const BINANCE_LOGO = "https://assets.coingecko.com/markets/images/52/large/binance.jpg";

export const binance = defineConnector({
  id: "binance",
  label: "Binance",
  logo: BINANCE_LOGO,
  account: { creds: binanceAccountCreds },
  // 单 kind connector:schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [binanceProvider] },
});
