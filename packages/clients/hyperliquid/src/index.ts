// @folio/hyperliquid-client —— Hyperliquid REST 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parseClearinghouseState`、永续的计价模型
// (权益行带值 / 仓位行 value=0)、`tokenRef` 命名、`accountCreds` 的地址校验,全在适配层(ADR 0036)。
//
// 用法:`Effect.provide(HyperliquidClient.layer())`,业务里 `yield* HyperliquidClient` 取服务。
//
// 这家上游的特点:**只读地址即查,无签名、无 key、无闸**(额度按 IP 算但远够用,见 constants.ts)。
// 所以本包是七个 client 里最薄的一个 —— 薄成这样也仍然值得独立成包,因为「怎么跟上游说话」
// 和「上游的话是什么意思」是两件会各自变化的事。
export {
  HyperliquidClient,
  type HyperliquidClientApi,
  type HyperliquidConfig,
  make,
} from "./client";
export { HYPERLIQUID_API_BASE } from "./constants";
export type { ClearinghouseState, HlLeverage, HlMarginSummary, HlPosition } from "./types";
