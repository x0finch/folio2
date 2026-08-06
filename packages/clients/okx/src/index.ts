// @folio/okx-client —— OKX v5 REST 的请求层(签名 / 六个端点 / 业务码归类)。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parseBalances`、价格提示表(eqUsd/eq 当市价)、
// earn 残差合成行、冻结 note 文案、逐桶尽力而为的编排,全在适配层(ADR 0036)。
//
// 用法:`Effect.provide(OkxClient.layer({ apiBase }))`,业务里 `yield* OkxClient` 取服务。
//
// 这家上游有三处与别家不同,都在本包里兜住了:
//   · **签名串里的 requestPath 含 query**,而且时间戳是 ISO 串不是毫秒数
//   · **凭据有 passphrase**(binance / Bybit 都没有)
//   · **业务错误是 HTTP 200 + code ≠ "0"**,code 是**字符串**(Bybit 的 retCode 是数字)
export { make, OkxClient, type OkxClientApi, type OkxConfig } from "./client";
export { OKX_API_BASE } from "./constants";
export type {
  OkxBalanceResponse,
  OkxCreds,
  OkxDetail,
  OkxEnvelope,
  OkxFundingAsset,
  OkxFundingResponse,
  OkxPositionsResponse,
  OkxSavingsResponse,
  OkxSavingsRow,
  OkxStakingInvest,
  OkxStakingOrder,
  OkxStakingResponse,
  OkxValuationDetails,
  OkxValuationResponse,
} from "./types";
