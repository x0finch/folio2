// 参考层四个端口的 D1 实现。**薄壳**。
//
// 这半实现的接口不是 db 自己定的 —— 是 `@folio/oracle-basic` 的四个端口(ADR 0021/0022/0023)。
// 目录名说的就是这件事:`stores/` 只说了「是存东西的」,`oracle-ports/` 说清了「实现的是谁的契约」。
//
// 出口是 **Layer 而不是工厂**:「怎么变成那个端口」归实现方,装配点只管把它接上。
// 四个 layer 共用同一个 `DbClient`(`../client.ts`),`env` 只在 `dbClientLayer(env)` 一处被读。
export { userCacheStoreLayer } from "./cache";
export { globalTokenRefIndexStoreLayer } from "./global-ref-index";
export { type UserTokenStoreOpts, userTokenStoreLayer } from "./token";
export { type UserTokenPriceStoreOpts, userTokenPriceStoreLayer } from "./token-price";
