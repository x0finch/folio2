import { defineConnector, Spot } from "@folio/connectors-basic";
import { coinstatsAccountCreds, createCoinstatsProvider } from "./coinstats/provider";

// solana connector manifest —— 组装契约(基座)+ provider(coinstats,connectionId "solana")。
// coinstats 一个 provider 包服务 solana/sui/cosmos 三个 connector:AC 声明与工厂共享,
// 各 connector 只是绑定不同的 connectionId。manifest 组装归 entry。
// logo:固定的 CoinGecko SOL 图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const SOL_LOGO = "https://assets.coingecko.com/coins/images/4128/large/solana.png";

export const solana = defineConnector({
  id: "solana",
  label: "Solana",
  logo: SOL_LOGO,
  account: { creds: coinstatsAccountCreds },
  // 单 kind connector:schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [createCoinstatsProvider("solana")] },
});
