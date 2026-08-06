// @folio/coinstats-client —— CoinStats OpenAPI 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parseBalances`、`tokenRef` 的链/合约命名、
// 「无 chain 的 coin 回落到 connectionId」那条规则、三条链各自的 connector manifest,
// 全在适配层(ADR 0036)。
//
// 用法:`Effect.provide(CoinstatsClient.layer())`,业务里 `yield* CoinstatsClient` 取服务。
//
// 这家上游的特点:**一把 key 服务三条链**(solana / sui / cosmos),所以闸必须是跨 isolate 的
// (见 constants.ts)。apiKey 与 connectionId 都是**每次调用传** —— 一个 client 服务全部三条链、
// 全部账户。
export { CoinstatsClient, type CoinstatsClientApi, type CoinstatsConfig, make } from "./client";
export { COINSTATS_API_BASE } from "./constants";
export type { CoinstatsCoin } from "./types";
