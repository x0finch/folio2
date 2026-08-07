import { defineConnector, Spot } from "@folio/connectors-basic";
import { okxAccountCreds, okxProvider } from "./provider";

// okx connector manifest。secret 型 account.creds:apiKey/secret/passphrase 由 app 分派桥加密入库、
// 取数时 openCreds 解密后灌进 ctx.account.creds。
//
// 适配层住在这个目录(ADR 0036),请求那一半在 `@folio/okx-client`。
// logo:固定的 CoinGecko OKX 交易所图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const OKX_LOGO =
  "https://assets.coingecko.com/markets/images/96/large/WeChat_Image_20220117220452.png";

export const okx = defineConnector({
  id: "okx",
  label: "OKX",
  logo: OKX_LOGO,
  account: { creds: okxAccountCreds },
  // 单 kind connector:schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [okxProvider] },
});
