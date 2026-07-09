import { defineConnector, PerpEquity, PerpPosition } from "@folio/connectors-basic";
import {
  hyperliquidAccountCreds,
  hyperliquidProvider,
} from "@folio/connectors-provider-hyperliquid";
import { z } from "zod";

// hyperliquid connector manifest —— 组装契约(基座)+ provider(hyperliquid)。唯一的【多 kind】
// connector:balance.schema 是 perp_equity + perp_position 的判别联合(权益行带值、仓位行 value:0)。
// account.creds(EVM 地址,public)声明随 provider 落 provider 包,此处引入组合;无全局/provider key。
// logo:CoinGecko Hyperliquid 币图(best-effort,客户端展示仍经 folio logo 代理,ADR 0008)。
const HYPERLIQUID_LOGO = "https://assets.coingecko.com/coins/images/50882/large/hyperliquid.jpg";

export const hyperliquid = defineConnector({
  id: "hyperliquid",
  label: "Hyperliquid",
  logo: HYPERLIQUID_LOGO,
  account: { creds: hyperliquidAccountCreds },
  // 多 kind connector:schema = 该 connector 会吐的 kind 子集判别联合(perp_equity | perp_position)。
  balance: {
    schema: z.discriminatedUnion("kind", [PerpEquity, PerpPosition]),
    providers: [hyperliquidProvider],
  },
});
