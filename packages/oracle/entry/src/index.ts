// @folio/oracle —— 参考层的服务层与对外门面(#176 / ADR 0021 / 0022 / 0023)。
//
// 设计要点:
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是 app 在装配时注入的 Layer,
//     dependencies 里只有契约包与文法包,没有任何 client / upstream 包
//   · 服务全是 Effect 服务(`Context.GenericTag` + Layer,#362 第 4 站);时间走 `Clock`,
//     降级走 `catchAll(UpstreamError)` 并记一行,配置回调一个不剩
//
// 三包一族:`@folio/oracle-basic`(契约,含 `./ports` 那个只有服务端会碰的 Tag 入口)/
// `@folio/oracle`(本包,服务)/ `@folio/oracle-upstream-coingecko`(上游 adapter)。
//
// **对外三个服务**,按领域分(为什么是三个、以前那五个多切了哪两刀,见 `oracle.ts`):
//   `TokenService` 代币 · `FxService` 汇率 · `PlatformService` 平台
//
// **src 的编排判据:一个领域一个位置,没有分类目录。**
//
//   `tokens/`      代币 —— 它自己就是一个文件夹(十二个方法、六片实现 + 它专属的内部件),
//                  从 `./tokens` 这个 index 出口对外;那个文件的开头有它内部的分片图
//   `fx.ts`        汇率
//   `platforms.ts` 平台
//   `oracle.ts`    per-user 装配(三个服务拼成 `oracleLayer`)
//   `ref-index.ts` cron 的全局维护任务 —— 导出,但它不是服务、也不属于 per-user 装配
//   `index.ts`     本文件,唯一的对外出口
//
// **没有 `services/`,也没有 `internal/`。** 前者是废话(这一层除了服务没有别的);后者曾经装着
// 六件共用件,但真正三家共用的只有降级与 SWR 两个组合子,其余四件只有代币用得上 —— 一个只为
// 「不外露」而存在的目录,读的人会误以为里面的东西谁都在用。现在**每一件都住在用它的那个领域里**,
// 而「外不外露」由这个出口说了算:没写在下面的,包外就拿不到。
//
// 代价说清楚:降级(`tokens/degrade`)与 SWR(`tokens/refresh`)两个组合子领域中立,却住在
// `tokens/` 里,于是 `fx.ts` / `platforms.ts` 要 `import from "./tokens/degrade"`。
// 哪天第四个领域也要 SWR,这两件该提回一个共用位置。
//
// 每个服务名同时是**类型**和**Tag**(`Context.GenericTag`,与 `@effect/platform` 的
// `FileSystem` / `HttpClient` 同款),所以一行 `export { TokenService }` 两个含义都带出去。
//
// **本包整个只有服务端会碰,所以它不转发 `@folio/oracle-basic`。**
//
// 以前这里有一句 `export * from "@folio/oracle-basic"`,图的是「调用方一个 import 面」。
// 代价是这个入口同时供着**契约**(客户端组件真的要 `tokenTicket` / `valuate` /
// `SUPPORTED_CURRENCIES`)和几个 Tag(`Context.GenericTag(...)`,运行时值)——
// 一个组件为了拿契约 import 了本包,`effect` 就跟进客户端 bundle(+75 KB gzip)。
// 今天没进,只是碰巧没人这么写;`@folio/oracle-basic` 为同一个理由早就把 Tag 拆去了 `./ports`。
// 去掉这句之后,客户端要契约只有一条路(`@folio/oracle-basic`),而那条路上没有 `effect`。
//
// (下面这串按字母序 —— Biome 排的,别照着它读结构;结构见上面那张图。)

export { FxService } from "./fx";
export { type OraclePorts, type OracleServices, oracleLayer } from "./oracle";
export { PlatformService } from "./platforms";
export { refIndexRefreshedAt, warmRefIndex } from "./ref-index";
export { type MintInput, type RefreshStaleReport, TokenService } from "./tokens";
