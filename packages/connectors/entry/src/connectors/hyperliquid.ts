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
  // balance.schema = 该 connector 会吐的 kind 子集,是 defineConnector 推断 provider 输出类型 B 的**事实源**:
  //   B = z.infer<typeof schema>,fetchBalances 被窄化到 B → 写错 kind(如 spot)编译即挂(见 provider 的 Row)。
  // 多 kind(perp 同时吐 perp_equity + perp_position)→ 用 z.discriminatedUnion("kind", [...]);
  //   判别键 "kind" 让 zod 按 kind 路由,也是 B 的判别式。
  // 单 kind connector(如 bitcoin 只吐 utxo、solana 只吐 spot)则直接把那个 kind schema(Utxo / Spot)当 schema,无需包一层 union。
  // (schema 现主要供类型推断;运行时可选 schema.parse 校验 provider 输出,registry/桥当前不强制。)
  balance: {
    schema: z.discriminatedUnion("kind", [PerpEquity, PerpPosition]),
    providers: [hyperliquidProvider],
  },
});
