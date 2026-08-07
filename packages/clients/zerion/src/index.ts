// @folio/zerion-client —— Zerion API 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parsePositions`(spot/defi 判别、负债腿取负、
// displayable 过滤、implementations 里找当前链)、`tokenRef` 的 `evm:<chainId>` 命名,全在适配层
// (ADR 0036)。
//
// 用法:`Effect.provide(ZerionClient.layer())`,业务里 `yield* ZerionClient` 取服务。
//
// 这家上游的两个特点都在这里兑现:**HTTP Basic 认证**(key 作 username、密码空),
// 以及 **slug→chainId 映射的 24h 缓存**(链清单近静态,不缓存就是每轮白拉一发还占额度)。
export { make, ZerionClient, type ZerionClientApi, type ZerionConfig } from "./client";
export { POSITIONS_QUERY, ZERION_API_BASE } from "./constants";
export type {
  ZerionChain,
  ZerionChainsResponse,
  ZerionImplementation,
  ZerionPosition,
  ZerionPositionsResponse,
  ZerionQuantity,
} from "./types";
