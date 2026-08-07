import { Defi, defineConnector, Spot } from "@folio/connectors-basic";
import { z } from "zod";
import { evmAccountCreds } from "./creds";
import { rabbyProvider } from "./rabby-provider";
import { zerionProvider } from "./zerion-provider";

// evm connector manifest —— 组装契约(基座)+ 两个 provider。
// 适配层住在这个目录(ADR 0036),请求那两半分别在 `@folio/rabby-client` 与 `@folio/zerion-client`。
//
// **provider 顺序即优先级**:rabby 默认,zerion 备(`defaultEnabled: false`)。
// selectProvider 取第一个 defaultEnabled !== false 的,所以取数走 rabby;zerion 留着是为了
// 将来做「运行时选源」(ADR 0009 决策 #8),不是死码。
// 为什么 rabby 当默认:不要 API key(少一个 secret),两个请求拿回全链。代价是请求得签名 ——
// 那套 wasm 签名怎么进 Worker 见 `@folio/rabby-client` 的 src/signer.ts。
// account.creds 现在**只有一份**(`provider.ts` 里)—— 它是 connector 的属性(这个账户怎么标识),
// 不是某个数据源的。拆包前 rabby 包里还有一份本地声明只为类型,那份随包一起没了。
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
