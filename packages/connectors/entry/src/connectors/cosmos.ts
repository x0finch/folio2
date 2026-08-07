import { defineConnector, Spot } from "@folio/connectors-basic";
import { coinstatsAccountCreds, createCoinstatsProvider } from "./coinstats/provider";

// cosmos connector manifest —— 组装契约(基座)+ provider(coinstats,connectionId "cosmos")。
// logo:固定的 CoinGecko ATOM 图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const ATOM_LOGO = "https://assets.coingecko.com/coins/images/1481/large/cosmos_hub.png";

export const cosmos = defineConnector({
  id: "cosmos",
  label: "Cosmos",
  logo: ATOM_LOGO,
  account: { creds: coinstatsAccountCreds },
  // 单 kind connector:schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [createCoinstatsProvider("cosmos")] },
});
