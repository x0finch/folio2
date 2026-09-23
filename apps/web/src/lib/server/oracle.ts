import { env } from "cloudflare:workers";
import { DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { GlobalRefIndexService, type OracleServices, oracleLayer } from "@folio/oracle";
import { coinGeckoUpstreamLayers, UPSTREAM_ID } from "@folio/oracle-upstream-coingecko";
import { Layer } from "effect";

// 参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一边是 D1 store,一边是 CoinGecko adapter;`@folio/oracle` 自己两边都不认识。
//
// #362 第 4 站之后这里给的是 **Layer**,不再是 `createOracleFor({ 七个工厂回调 })`。
// 少掉的东西:七个 `createXxx(userId)` 字段、`overrides` 的转手(adapter 的 layer 自己给
// `Namer`)、`onWarn` 回调(改 Effect 日志 + 下面那个转发器)、`now`(改 `Clock`)。
//
// **这里只说「参考层由哪些 layer 拼成」,不跑、也不给请求的东西**(ADR 0054)。拼出来的这张
// layer 每个 isolate 只建一次(`runtime.ts` 的 isolate 运行时):它里面没有连接、没有用户 ——
// db 那几张门票的 op 在跑的那一刻才从 context 里取这两样,由装配点每请求给。以前这个文件还有
// `perRequestLayer` / `withOracleWarm` / `runAtEdge`,它们都是「每请求装一遍」那个形状的零件,
// 随那个形状一起退场(`runtime.ts` 里还有 cron 用的边缘)。

// CoinGecko client 的公共配置(三个上游共用一份)。限速层的报告不在这里 —— 见 log.ts 的
// setLimitLogger:那件事是运行时的属性,设一次管所有闸,不该逐个上游透传。
//
// **isolate 建一次就读这一次**:`env` 是部署级的(同一个 isolate 里每个请求看到的是同一份),
// 所以把 key 冻进 isolate 级的 client 不会让哪个请求读到别人的值。换 key 要重新部署,那本来就
// 起一批新 isolate。
const cgConfig = () => ({ apiKey: env.COINGECKO_API_KEY || undefined });

// 当前上游的命名者。db 层不预设任何厂商(表名列名零 vendor 字样,#199),所以凡是要按命名者
// 点查 `token_refs` 的读(如手记持仓的「用户选了哪个币」)都由 app 把它传进去。
// 取 adapter 导出的常量而不是从服务里拿 —— 后者会在模块加载期读 env(Workers 启动 CPU 限制)。
export const NAMER = UPSTREAM_ID;

// 三个上游端口 + 命名身份。**各自一个 layer**:汇率、平台、代币身份是三件事,当前恰好都落在
// CoinGecko 上,但那是这一行的选择,服务层不知道它们是同一家(ADR 0023)。
//
// **config 取一次、client 建一次**:三格出自同一个 `coinGeckoUpstreamLayers`,挂在同一个传输层
// 引用上,所以一次构建只建一个 CoinGecko client。哪天某一格换供应商,换掉那一格就行。
//
// **它能进 isolate 级的运行时,是查过的**(ADR 0054 的清单):client 建的时候只造一份请求头 +
// 两个闭包;限频闸在生产那一档(`isolated`)是 `Effect.sync` 里造的闭包,游标本来就活在模块级
// (client-core 的 `slot-cursor.ts`,跨请求共享是它的设计);`FetchHttpClient` 每一发现取
// `globalThis.fetch`、现建 `AbortController`。**没有一样是 fiber、timer 或 I/O 句柄** ——
// Workers 那条「不能替另一个请求做 I/O」管不到它们。唯一会在建的时候 fork 一条后台 fiber 的是
// 限频的 `memory` 档(官方 `RateLimiter`),而生产从不走那一档。
const upstreams = () => {
  const cg = coinGeckoUpstreamLayers(cgConfig());
  return Layer.mergeAll(cg.token, cg.fx, cg.platform, cg.namer);
};

// 参考层要的本地那几片 —— **两张 db 门票**,不是一排端口(#504 T5 之后又收了一次:
// `oracle-ports/` 那个目录整个没了,契约就是 db 里的实现)。
//   · `DatabaseForOracle` 代币行 / 价格行 / 缓存,per-user(op 跑的那一刻取用户)
//   · `GlobalDatabase`    mint 要正查的那张全局映射表,没有 userId
//
// **`namer` 在这里传进去**:db 层不预设任何厂商(表名列名零 vendor 字样,#199),而凡是要按
// 命名者点查 `token_refs` 的读、以及历史日价那条全局键都要它。取 adapter 导出的常量,
// 不从 `Namer` 服务里 yield —— 那会让 db 反过来消费参考层的一个服务。
const dbForOracle = () =>
  Layer.merge(DatabaseForOracle.Default(UPSTREAM_ID), GlobalDatabase.Default);

/**
 * 参考层,装好、封住 —— 出去的是它那三个域服务 + cron 刷全局映射表的那个门面,外加
 * **不带 userId 的那张 db 门票**(`GlobalDatabase`:cron 扫「有哪些用户」要它)。
 *
 * **`DatabaseForOracle` 不往外透(#504 T17 那道收窄,是结构性的)**:代币行与价格行住在它上面,
 * 这张 layer 把它喂进参考层之后就**不再往外透** —— handler 在运行时也拿不到它,不只是类型上。
 * app 要的那片 KV 缓存不从这儿漏 —— 它在 `Database` 上(`db.cache`)。
 *
 * `GlobalDatabase` 透出去是因为参考层自己也在用它(mint 正查全局映射表):两边拿到的是同一份,
 * 它上面**没有一条用户数据**(ADR 0022),handler 的 `UserServices` 里也没有它
 * (`user-services-surface.test.ts` 钉着)。
 */
export const oracleServices = (): Layer.Layer<
  OracleServices | GlobalRefIndexService | GlobalDatabase
> =>
  Layer.provide(
    Layer.merge(oracleLayer, GlobalRefIndexService.Default),
    Layer.merge(dbForOracle(), upstreams()),
  ).pipe(Layer.provideMerge(GlobalDatabase.Default));
