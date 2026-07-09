import { defineConnector, Spot } from "@folio/connectors-basic";
import {
  coinstatsAccountCreds,
  createCoinstatsProvider,
} from "@folio/connectors-provider-coinstats";

// sui connector manifest —— 组装契约(基座)+ provider(coinstats)。
// ⚠️ connectionId 是 "sui-wallet" 而非 "sui"(经 CoinStats /wallet/blockchains 实测确认;behavior-preserving)。
// logo:固定的 CoinGecko SUI 图 —— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const SUI_LOGO = "https://assets.coingecko.com/coins/images/26375/large/sui-ocean-square.png";

export const sui = defineConnector({
  id: "sui",
  label: "Sui",
  logo: SUI_LOGO,
  account: { creds: coinstatsAccountCreds },
  // 单 kind connector:schema 直接用 Spot(无需判别联合)。
  balance: { schema: Spot, providers: [createCoinstatsProvider("sui-wallet")] },
});
