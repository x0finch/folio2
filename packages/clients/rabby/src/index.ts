// @folio/rabby-client —— Rabby(实为 DeBank 后端)API 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— `parseTokens` / `parseProtocols`(垃圾币过滤、
// 负债腿取负、协议仓位展开)、`tokenRef` 命名、dust 过滤,全在适配层(ADR 0036)。
//
// 用法:`Effect.provide(RabbyClient.layer())`,业务里 `yield* RabbyClient` 取服务。
//
// 这家上游的三处特别都在本包里:
//   · **不要 API key,但请求必须签名**(wasm,见 sign.ts)—— 不签不是 401 而是「每 40 秒一发」
//     的限速档位。签名器是**可选服务**,所以普通 node 测试能替掉它、不必碰 wasm
//   · **闸 limit=1,不许突发** —— 它掐的是瞬时并发不是总量,而且 429 不带 Retry-After
//   · **slug→chainId 的 24h 缓存**(`community_id` 就是规范 chainId)
export { make, parseChainIds, RabbyClient, type RabbyClientApi, type RabbyConfig } from "./client";
export { RABBY_API_BASE } from "./constants";
export { RabbySigner, type SignRequest } from "./signer";
export type { RabbyChain, RabbyProtocol, RabbyProtocolItem, RabbyToken } from "./types";
