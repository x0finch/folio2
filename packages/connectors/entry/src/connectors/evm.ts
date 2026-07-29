import { Defi, defineConnector, Spot } from "@folio/connectors-basic";
import { rabbyProvider } from "@folio/connectors-provider-rabby";
import { evmAccountCreds, zerionProvider } from "@folio/connectors-provider-zerion";
import { z } from "zod";

// evm connector manifest —— 组装契约(基座)+ providers。manifest 组装归 entry;
// account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
//
// **provider 顺序即优先级**:rabby 默认,zerion 备(`defaultEnabled: false`)。
// selectProvider 取第一个 defaultEnabled !== false 的,所以取数走 rabby;zerion 留着是为了
// 将来做「运行时选源」(ADR 0009 决策 #8),不是死码。
// 为什么 rabby 当默认:不要 API key(少一个 secret),两个请求拿回全链。代价是请求得签名 ——
// 那套 wasm 签名怎么进 Worker 见 @folio/connectors-provider-rabby 的 src/sign.ts。
// account.creds 仍引 zerion 那份导出(两个 provider 共用同一份账户字段;rabby 包内那份本地声明
// 只为类型,键对不上 defineConnector 编译期就会拒)。
// logo:固定的 CoinGecko ETH 图(EVM 生态以 ETH 为标)—— 客户端展示时仍经 folio logo 代理(ADR 0008)。
const ETH_LOGO = "https://assets.coingecko.com/coins/images/279/large/ethereum.png";

export const evm = defineConnector({
  id: "evm",
  label: "EVM",
  logo: ETH_LOGO,
  account: { creds: evmAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, Defi]),
    providers: [rabbyProvider, zerionProvider],
  },
});
