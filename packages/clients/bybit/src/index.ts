// @folio/bybit-client —— Bybit v5 REST 的请求层(签名 / 三个账户桶 / 业务码归类)。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parse*`、locked 段的展示文案、
// `totalPerpUPL` 的永续兜底信号、逐桶尽力而为的编排(ADR 0030),全在适配层(ADR 0036)。
//
// 用法:`Effect.provide(BybitClient.layer({ apiBase }))`,业务里 `yield* BybitClient` 取服务。
//
// 这家上游有两处坑,都在本包里堵住了:
//   · **业务错误是 HTTP 200 + retCode ≠ 0**(数字,异于 OKX 的字符串 code)。不查它的话,
//     签名错会表现成「这个账户余额是 0」—— 静默丢数据
//   · **被签的 queryString 必须与发出去的一字不差**,否则只回一句 retCode 10004
export { BybitClient, type BybitClientApi, type BybitConfig, make } from "./client";
export {
  BYBIT_API_BASE,
  EARN_CATEGORY_FLEXIBLE,
  EARN_CATEGORY_ONCHAIN,
} from "./constants";
export type {
  BybitCoin,
  BybitCreds,
  BybitEarnPosition,
  BybitEarnResponse,
  BybitEnvelope,
  BybitFundingCoin,
  BybitFundingResponse,
  BybitWalletBalanceResponse,
} from "./types";
